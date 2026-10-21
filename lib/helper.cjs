'use strict'

/**
 * dsh-power-menu — detached handoff helper.
 *
 * Runs as Electron's Node mode (`ELECTRON_RUN_AS_NODE=1`) so it does not
 * depend on a system Node. It outlives the host because it is the only piece
 * that must survive the Electron main process being ended.
 *
 * Shutdown:
 *   1. wait for the browser to receive the HTTP acknowledgement;
 *   2. end ONLY the Electron main process (`taskkill /PID <main> /F`, no /T);
 *      the host's IPC channel then disconnects and the host runs its own
 *      graceful `application.shutdown`, flushing session logs;
 *   3. wait for the web port to be released (the host exits when done).
 *
 * Before step 2 the helper snapshots the main process tree and excludes the
 * Host subtree. Once the Host has exited, it ends the leftover non-Host
 * children (GPU, renderers, plugin background servers) so they do not become
 * orphans. The Host itself is never killed with `/T` on the normal path,
 * because that would skip its graceful shutdown.
 *
 * The snapshot runs while the helper waits for the browser acknowledgement,
 * so the normal shutdown/restart path does not gain a fixed delay.
 *
 * Restart: the same, then wait for the port to free and relaunch the same
 * executable with a clean environment (ELECTRON_RUN_AS_NODE removed, or the
 * new instance would start without a window; stale proxy variables removed, or
 * the new instance inherits a relay port that no longer exists — see
 * STALE_ENV_KEYS). Verify the new process stays alive, retrying a couple of
 * times; if it never comes up, show a message box.
 */

const { execFile, execFileSync, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const fs = require('node:fs')
const net = require('node:net')
const os = require('node:os')
const path = require('node:path')

const execFileAsync = promisify(execFile)

const MAIN_EXIT_TIMEOUT_MS = 15000
const PORT_FREE_TIMEOUT_MS = 30000
const HOST_EXIT_TIMEOUT_MS = 25000
const ORPHAN_LIST_TIMEOUT_MS = 5000
const RELAUNCH_ATTEMPTS = 3
const WINDOW_VERIFY_TIMEOUT_MS = 20000
const WINDOW_POLL_MS = 500

/**
 * Environment variables the relaunched instance must not inherit.
 *
 * `ELECTRON_RUN_AS_NODE` would make the new instance start without a window.
 *
 * The proxy variables are a snapshot of the OLD process's network policy, and
 * they go stale across a restart. A plugin that installs a local relay writes
 * `HTTP_PROXY=http://127.0.0.1:<port>` once and keeps that port for the rest of
 * the process's life; the relaunched instance listens on a NEW port while every
 * child process it spawns still dials the dead one. DSH's own http-proxy layer
 * prefers an inherited env value over the policy a plugin supplies, so the stale
 * value keeps winning even after the plugin re-installs the correct one.
 *
 * Measured on DSH 0.2.1-rc.2 (Windows 11, Electron 44): after a restart through
 * this helper, `HTTP_PROXY` pointed at a loopback port that had nothing
 * listening, while the live relay was on a different port. `pnpm` failed with
 * ECONNREFUSED through three retry rounds, turning a plugin update into minutes
 * of waiting. Launching the same executable from Explorer instead produced a
 * clean environment and no failure.
 *
 * Names are compared uppercase: Windows treats the names case-insensitively,
 * but undici resolves the lowercase spelling first (`https_proxy ?? HTTPS_PROXY`),
 * so a copy that only removed the uppercase one would leave the lowercase
 * variant behind.
 */
const STALE_ENV_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'DSH_DESKTOP_NODE_EXECUTABLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
])

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

let LOG_PATH = ''

const MAX_LOG_BYTES = 1000000

function rotateLog(file) {
  try {
    if (fs.statSync(file).size > MAX_LOG_BYTES) {
      try { fs.rmSync(`${file}.1`, { force: true }) } catch { /* ignore */ }
      fs.renameSync(file, `${file}.1`)
    }
  } catch {
    /* no log file yet */
  }
}

/** Append one diagnostic line as UTF-8; never throws. */
function note(line) {
  try {
    rotateLog(LOG_PATH)
    fs.appendFileSync(LOG_PATH, `[${new Date().toISOString()}] ${line}\n`, 'utf8')
  } catch {
    /* no log is better than a failed action */
  }
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** Force-end one process. Returns whether taskkill reported success. */
function killPid(pid) {
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore', windowsHide: true })
    return true
  } catch {
    return false
  }
}

/**
 * Collect the descendants of `root`, skipping the subtrees rooted at
 * `skipRoots` (the Host and the helper itself). Pure function, so the
 * process-tree logic can be self-tested without touching a real app.
 */
function collectTree(rows, root, skipRoots = []) {
  if (!Number.isInteger(root) || root <= 1) return []
  const children = new Map()
  for (const row of rows) {
    const pid = Number(row?.ProcessId)
    const parent = Number(row?.ParentProcessId)
    if (!Number.isInteger(pid) || !Number.isInteger(parent)) continue
    if (!children.has(parent)) children.set(parent, [])
    children.get(parent).push(pid)
  }
  const skip = new Set((skipRoots ?? []).filter((pid) => Number.isInteger(pid) && pid > 1))
  const seen = new Set()
  const out = []
  const queue = [...(children.get(root) ?? [])]
  while (queue.length > 0) {
    const pid = queue.shift()
    if (seen.has(pid) || skip.has(pid)) continue
    seen.add(pid)
    out.push(pid)
    for (const child of children.get(pid) ?? []) queue.push(child)
  }
  return out
}

const PROCESS_QUERY = 'Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress -Depth 2'

/** Read the live process table once, with a small shell fallback. */
async function listProcesses() {
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    timeout: ORPHAN_LIST_TIMEOUT_MS,
    maxBuffer: 4 * 1024 * 1024,
  }
  let lastError = null
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const { stdout } = await execFileAsync(
        shell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PROCESS_QUERY],
        options,
      )
      const text = String(stdout).trim()
      if (text === '') return []
      const parsed = JSON.parse(text)
      return Array.isArray(parsed) ? parsed : [parsed]
    } catch (error) {
      lastError = error
    }
  }
  throw lastError ?? new Error('no PowerShell available')
}

/**
 * Snapshot the descendants that should be cleaned after the Host exits:
 * - `main`: main-process children except the Host subtree and this helper;
 * - `host`: Host children except this helper.
 * Called while the browser acknowledgement delay runs, so a normal
 * shutdown/restart does not pay an extra fixed wait.
 */
async function collectOrphans(mainPid, hostPid) {
  try {
    const rows = await listProcesses()
    const main = collectTree(rows, mainPid, [hostPid, process.pid])
    const host = collectTree(rows, hostPid, [process.pid])
    note(`orphans: snapshot main=${main.length} host=${host.length}`)
    return { main, host }
  } catch (error) {
    note(`orphans: snapshot failed: ${String(error?.message ?? error)}`)
    return { main: [], host: [] }
  }
}

/** End the snapshotted leftovers; keep the Host out of the cleanup. */
async function cleanupOrphans(orphans, label, includeHost = true) {
  const main = Array.isArray(orphans?.main) ? orphans.main : []
  const host = Array.isArray(orphans?.host) ? orphans.host : []
  if (!includeHost && host.length > 0) {
    note(`${label}: host is still alive; skipping ${host.length} host child(ren)`)
  }
  const pids = [...new Set([...main, ...(includeHost ? host : [])])]
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid)
  const live = pids.filter(alive)
  if (live.length === 0) {
    note(`${label}: no orphan processes left`)
    return
  }
  note(`${label}: ending ${live.length} orphan process(es): ${live.join(',')}`)
  let ended = 0
  for (const pid of live) if (killPid(pid)) ended += 1

  // One short retry catches a process that was still tearing down when
  // taskkill returned. It does not claim to catch detached/new processes.
  await sleep(300)
  const remaining = live.filter(alive)
  if (remaining.length > 0) {
    note(`${label}: retrying ${remaining.length} orphan process(es): ${remaining.join(',')}`)
    for (const pid of remaining) if (killPid(pid)) ended += 1
  }
  const stubborn = live.filter(alive)
  note(`${label}: ended ${ended}/${live.length} orphan process(es)${stubborn.length === 0 ? '' : `; ${stubborn.length} still alive: ${stubborn.join(',')}`}`)
}

/** Pure tree test; run with `helper.cjs --selftest`. */
function selfTest() {
  const rows = [
    { ProcessId: 100, ParentProcessId: 0 },
    { ProcessId: 101, ParentProcessId: 100 },
    { ProcessId: 102, ParentProcessId: 100 },
    { ProcessId: 103, ParentProcessId: 102 },
    { ProcessId: 104, ParentProcessId: 102 },
    { ProcessId: 105, ParentProcessId: 104 },
    { ProcessId: 106, ParentProcessId: 100 },
  ]
  const main = collectTree(rows, 100, [102, 103])
  const host = collectTree(rows, 102, [103])
  const ok = JSON.stringify(main) === '[101,106]' && JSON.stringify(host) === '[104,105]'
  console.log(JSON.stringify({ ok, main, host }))
  return ok
}

/**
 * Unicode path test; run with `helper.cjs --pathtest`.
 * Uses a Chinese + space temp directory, a UTF-8 JSON round-trip, and a
 * spawned executable copied to a Chinese path.
 */
async function pathTest() {
  let dir = ''
  try {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-power-menu 中文路径 '))
    const jsonPath = path.join(dir, '中文 日志.json')
    const payload = { 中文路径: 'ok', emoji: '🐋' }
    fs.writeFileSync(jsonPath, JSON.stringify(payload), 'utf8')
    const roundTrip = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))

    const sourceCmd = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'cmd.exe')
    const copiedCmd = path.join(dir, '中文 cmd.exe')
    fs.copyFileSync(sourceCmd, copiedCmd)
    const exited = await new Promise((resolve) => {
      const child = spawn(copiedCmd, ['/d', '/c', 'exit', '0'], {
        cwd: dir,
        windowsHide: true,
        stdio: 'ignore',
      })
      child.on('error', () => resolve(false))
      child.on('exit', (code) => resolve(code === 0))
    })

    const ok = JSON.stringify(roundTrip) === JSON.stringify(payload) && exited
    console.log(JSON.stringify({ ok, dir, utf8: true, spawnedChineseExe: exited }))
    return ok
  } catch (error) {
    console.log(JSON.stringify({ ok: false, error: String(error?.message ?? error) }))
    return false
  } finally {
    if (dir !== '') {
      try {
        fs.rmSync(dir, { recursive: true, force: true })
      } catch {
        /* temp cleanup is best effort */
      }
    }
  }
}

/** Whether something is accepting connections on the loopback port. */
function listening(port) {
  return new Promise((resolve) => {
    let settled = false
    const probe = net.connect({ host: '127.0.0.1', port })
    const finish = (value) => {
      if (settled) return
      settled = true
      probe.destroy()
      resolve(value)
    }
    probe.on('connect', () => finish(true))
    probe.on('error', () => finish(false))
    probe.setTimeout(600, () => finish(false))
  })
}

async function waitFor(predicate, timeoutMs, stepMs) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await predicate()) return true
    await sleep(stepMs)
  }
  return await predicate()
}

/** Best-effort message box for the "app did not come back" path. */
function alertUser(text) {
  const script = `Add-Type -AssemblyName PresentationFramework; [System.Windows.MessageBox]::Show(${JSON.stringify(text)}, 'DeepSeek Harness') | Out-Null`
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const child = spawn(shell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      })
      child.unref()
      return true
    } catch {
      /* try the next shell */
    }
  }
  return false
}

async function performShutdown(handoff) {
  note('shutdown: ending the Electron main process (the host will close gracefully)')
  const killed = killPid(handoff.mainPid)
  note(killed ? `shutdown: taskkill /PID ${handoff.mainPid} /F ok` : `shutdown: taskkill reported an error for pid ${handoff.mainPid}`)

  const mainGone = await waitFor(() => !alive(handoff.mainPid), MAIN_EXIT_TIMEOUT_MS, 200)
  note(mainGone ? 'shutdown: main process exited' : `shutdown: main process still alive after ${MAIN_EXIT_TIMEOUT_MS}ms`)

  if (Number.isInteger(handoff.port) && handoff.port > 0) {
    const portFree = await waitFor(async () => !(await listening(handoff.port)), HOST_EXIT_TIMEOUT_MS, 300)
    note(portFree ? `shutdown: port ${handoff.port} released` : `shutdown: port ${handoff.port} still held`)
  }

  if (alive(handoff.hostPid)) {
    note(`shutdown: host ${handoff.hostPid} is still alive; ending it`)
    killPid(handoff.hostPid)
  } else {
    note('shutdown: host exited on its own')
  }
  await cleanupOrphans(handoff.orphans, 'shutdown', !alive(handoff.hostPid))
  note('shutdown: complete')
}

/** Best-effort main-window probe for a relaunched pid. */
function windowInfo(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return null
  // PowerShell 5.1 redirects output in the console code page, not UTF-8.
  // Base64 keeps the window title intact so the crash-dialog check works for
  // Chinese titles too.
  const script = `$p=Get-Process -Id ${pid} -ErrorAction SilentlyContinue; if($null -ne $p){ $json=[pscustomobject]@{ handle=[int64]$p.MainWindowHandle; title=[string]$p.MainWindowTitle } | ConvertTo-Json -Compress; [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json)) }`
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const out = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 3000,
      })
      const text = String(out).trim()
      if (text === '') return null
      const data = JSON.parse(Buffer.from(text, 'base64').toString('utf8'))
      return { handle: Number(data.handle) || 0, title: String(data.title ?? '') }
    } catch {
      /* try the next shell */
    }
  }
  return null
}

const BAD_WINDOW_RE = /无法使用|无法启动|应用无法|has stopped|crash/i

/**
 * Wait for a real main window instead of treating "process is alive" as
 * success. A white screen or a DSH crash dialog must not count as a restart.
 */
async function waitForWindow(pid, timeoutMs = WINDOW_VERIFY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs
  let lastTitle = ''
  while (Date.now() < deadline) {
    if (!alive(pid)) return { ok: false, reason: 'process-exited', title: lastTitle }
    const info = windowInfo(pid)
    if (info !== null) {
      lastTitle = info.title
      if (info.handle > 0) {
        if (BAD_WINDOW_RE.test(info.title)) {
          return { ok: false, reason: 'error-window', title: info.title }
        }
        return { ok: true, title: info.title }
      }
    }
    await sleep(WINDOW_POLL_MS)
  }
  return { ok: false, reason: 'timeout', title: lastTitle }
}

async function performRestart(handoff) {
  note('restart: ending the Electron main process (the host will close gracefully)')
  const killed = killPid(handoff.mainPid)
  note(killed ? `restart: taskkill /PID ${handoff.mainPid} /F ok` : `restart: taskkill reported an error for pid ${handoff.mainPid}`)

  const mainGone = await waitFor(() => !alive(handoff.mainPid), MAIN_EXIT_TIMEOUT_MS, 200)
  note(mainGone ? 'restart: main process exited' : `restart: main process still alive after ${MAIN_EXIT_TIMEOUT_MS}ms`)

  let portFree = true
  if (Number.isInteger(handoff.port) && handoff.port > 0) {
    portFree = await waitFor(async () => !(await listening(handoff.port)), PORT_FREE_TIMEOUT_MS, 300)
    note(portFree ? `restart: port ${handoff.port} released` : `restart: port ${handoff.port} still held`)
    if (!portFree) {
      if (alive(handoff.hostPid)) {
        note(`restart: host ${handoff.hostPid} still holds the port; ending it as a last resort (session logs may be incomplete)`)
        killPid(handoff.hostPid)
        await sleep(1500)
      }
      portFree = await waitFor(async () => !(await listening(handoff.port)), 5000, 300)
    }
  }

  // Give the socket and the filesystem a moment to settle before relaunching.
  await cleanupOrphans(handoff.orphans, 'restart', !alive(handoff.hostPid))
  await sleep(portFree ? 800 : 1500)

  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    if (STALE_ENV_KEYS.has(key.toUpperCase())) delete env[key]
  }

  const rawExe = String(handoff.exe ?? '').trim()
  if (rawExe === '') {
    note('restart: no executable in the handoff; aborting')
    alertUser('重启失败：交接信息里没有应用路径。请手动启动 DeepSeek Harness。')
    return
  }

  // Windows paths may contain Chinese, spaces, or other non-ASCII characters.
  // Keep the path as a single argv value and let Node/CreateProcessW handle it;
  // never build a shell command string.
  const exe = path.resolve(rawExe)
  if (!fs.existsSync(exe) || !fs.statSync(exe).isFile()) {
    note(`restart: executable does not exist: ${exe}`)
    alertUser(`重启失败：找不到应用路径。\n\n${exe}\n\n请手动启动 DeepSeek Harness。`)
    return
  }
  const exeDir = path.dirname(exe)

  let childPid = null
  for (let attempt = 1; attempt <= RELAUNCH_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      note(`restart: attempt ${attempt}/${RELAUNCH_ATTEMPTS} in 1500ms`)
      await sleep(1500)
    }
    let child = null
    try {
      child = spawn(exe, [], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: exeDir,
        env,
      })
      child.on('error', (error) => note(`restart: spawn error: ${String(error?.message ?? error)}`))
      child.unref()
      note(`restart: relaunched ${exe} as pid ${String(child.pid)}`)
    } catch (error) {
      note(`restart: spawn threw: ${String(error?.stack ?? error)}`)
      continue
    }

    const result = await waitForWindow(child.pid, WINDOW_VERIFY_TIMEOUT_MS)
    if (result.ok) {
      note(`restart: new process ${String(child.pid)} has a window${result.title === '' ? '' : ` (${result.title})`}`)
      childPid = child.pid
      break
    }
    note(`restart: window not ready: ${result.reason}${result.title === '' ? '' : ` title=${result.title}`} (attempt ${attempt})`)
    if (result.reason === 'error-window' || result.reason === 'timeout') break
  }

  if (childPid === null) {
    note('restart: application did not come back with a usable window')
    const shown = alertUser(`重启失败：DeepSeek Harness 没有出现可用的主窗口。\n\n请手动启动应用。\n日志：${LOG_PATH}`)
    note(shown ? 'restart: failure notice dispatched' : 'restart: could not dispatch the failure notice')
    return
  }

  if (Number.isInteger(handoff.port) && handoff.port > 0) {
    // The desktop app binds a fresh random port on every launch (`--port 0`),
    // so waiting for the NEW instance to take the OLD port would always time
    // out; the window check above is the meaningful readiness signal.
    note(`restart: old port ${handoff.port} is no longer relevant; the new instance picks its own port`)
  }
  note('restart: complete')
}

async function main() {
  if (process.argv[2] === '--selftest') {
    process.exit(selfTest() ? 0 : 1)
  }
  if (process.argv[2] === '--windowtest') {
    const pid = Number(process.argv[3])
    const timeout = Number(process.argv[4]) > 0 ? Number(process.argv[4]) : 5000
    const result = await waitForWindow(pid, timeout)
    console.log(JSON.stringify(result))
    process.exit(result.ok ? 0 : 1)
  }
  if (process.argv[2] === '--pathtest') {
    const ok = await pathTest()
    process.exit(ok ? 0 : 1)
  }
  if (process.argv[2] === '--snapshot') {
    const mainPid = Number(process.argv[3])
    const hostPid = Number(process.argv[4])
    const snapshot = await collectOrphans(mainPid, hostPid)
    console.log(JSON.stringify(snapshot))
    return
  }
  if (process.argv[2] === '--plan' || process.argv[2] === '--dryrun') {
    const planPath = process.argv[3]
    let handoff = null
    const reasons = []
    if (typeof planPath !== 'string' || planPath === '') {
      reasons.push('missing handoff path')
    } else {
      try {
        handoff = JSON.parse(fs.readFileSync(planPath, 'utf8'))
      } catch (error) {
        reasons.push(`cannot read handoff: ${String(error?.message ?? error)}`)
      }
    }
    if (handoff !== null) {
      if (handoff.mode !== 'shutdown' && handoff.mode !== 'restart') reasons.push(`invalid mode: ${String(handoff.mode)}`)
      if (!Number.isInteger(handoff.mainPid) || handoff.mainPid <= 1) reasons.push('invalid mainPid')
      if (!Number.isInteger(handoff.hostPid) || handoff.hostPid <= 1) reasons.push('invalid hostPid')
      const exe = typeof handoff.exe === 'string' ? path.resolve(handoff.exe) : ''
      if (exe === '' || !fs.existsSync(exe) || !fs.statSync(exe).isFile()) reasons.push(`missing executable: ${exe || '(empty)'}`)
      if (!fs.existsSync(__filename)) reasons.push(`missing helper: ${__filename}`)
      const logPath = typeof handoff.logPath === 'string' && handoff.logPath !== ''
        ? handoff.logPath
        : path.join(path.dirname(planPath), 'helper.log')
      console.log(JSON.stringify({
        ok: reasons.length === 0,
        mode: handoff.mode,
        mainPid: handoff.mainPid,
        hostPid: handoff.hostPid,
        exe: exe || String(handoff.exe ?? ''),
        port: handoff.port ?? null,
        logPath,
        helper: __filename,
        reasons,
      }, null, 2))
    } else {
      console.log(JSON.stringify({ ok: false, reasons }, null, 2))
    }
    process.exitCode = reasons.length === 0 ? 0 : 1
    return
  }

  const handoffPath = process.argv[2]
  if (typeof handoffPath !== 'string' || handoffPath === '') process.exit(1)

  let handoff
  try {
    handoff = JSON.parse(fs.readFileSync(handoffPath, 'utf8'))
  } catch {
    process.exit(1)
  }

  LOG_PATH = typeof handoff.logPath === 'string' && handoff.logPath !== ''
    ? handoff.logPath
    : path.join(path.dirname(handoffPath), 'helper.log')

  note(`helper started: helper=${process.pid} host=${String(handoff.hostPid)} main=${String(handoff.mainPid)} mode=${String(handoff.mode)}`)

  try {
    if (!Number.isInteger(handoff.mainPid) || handoff.mainPid <= 1) {
      note('refusing: the handoff carries no usable main process id')
      return
    }
    // Snapshot while the browser-acknowledgement delay runs; the collection
    // normally finishes well inside that window.
    const orphansPromise = collectOrphans(handoff.mainPid, handoff.hostPid)
    await sleep(Number.isFinite(handoff.delayMs) && handoff.delayMs > 0 ? handoff.delayMs : 1200)
    handoff.orphans = await orphansPromise
    if (handoff.mode === 'restart') await performRestart(handoff)
    else await performShutdown(handoff)
  } catch (error) {
    note(`helper failed: ${String(error?.stack ?? error)}`)
  } finally {
    try {
      fs.unlinkSync(handoffPath)
    } catch {
      /* already gone */
    }
  }
}

if (require.main === module) {
  main().catch(() => {
    process.exitCode = 0
  })
}
