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
 * executable. The inherited launch environment is filtered first:
 * ELECTRON_RUN_AS_NODE would start the new instance without a window, and a
 * proxy endpoint left by the previous instance points at a relay that no
 * longer exists. The arguments this instance was launched with are replayed,
 * so a non-default --user-data-dir is not silently dropped. Verify the new
 * process stays alive, retrying a couple of times; if it never comes up, show
 * a message box.
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
const ORPHAN_RETRY_ROUNDS = 3
const RESIDUAL_SWEEP_ROUNDS = 3
const RESIDUAL_SWEEP_GAP_MS = 400
const RELAUNCH_ATTEMPTS = 3
const WINDOW_VERIFY_TIMEOUT_MS = 20000
const WINDOW_POLL_MS = 500

// Inherited from the launcher of the previous instance. The relay endpoints
// these name belonged to that instance and are dead by now, and the stale
// value wins over whatever the new instance resolves. DSH_POWER_MENU_KEEP_PROXY=1
// keeps the proxy names for people who run a deliberate corporate proxy.
const STALE_ENV_KEYS = new Set([
  'ELECTRON_RUN_AS_NODE',
  'DSH_DESKTOP_NODE_EXECUTABLE',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'ALL_PROXY',
  'NO_PROXY',
  'NODE_USE_ENV_PROXY',
])
const PROXY_ENV_KEYS = new Set(['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'NODE_USE_ENV_PROXY'])
const COMMAND_LINE_TIMEOUT_MS = 8000

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

/** Version of the plugin this helper belongs to; a stale copy shows up in the log. */
function readPluginVersion() {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    const parsed = JSON.parse(raw)
    const version = typeof parsed.version === "string" ? parsed.version.trim() : ""
    return version === "" ? "unknown" : version
  } catch {
    return "unknown"
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

// --- graceful quit -----------------------------------------------------------
//
// The packaged shell keeps a hidden exit path. When the window event
// 'session-end' has fired, the close handler stops preventing the default
// (main.js:21471) and before-quit skips the task confirmation and runs the
// whole teardown chain: finishQuit -> stopOperationReports -> backend.close()
// -> host shutdown (main.js:21694). On Windows 'session-end' comes from
// WM_ENDSESSION, so posting WM_ENDSESSION and then WM_CLOSE hands the shell its
// own shutdown instead of killing it. taskkill stays as the fallback.

const WM_CLOSE = 0x0010
const WM_ENDSESSION = 0x0016

function windowMessageScript(pid, mode) {
  // The whole enumeration lives in C#: PowerShell 5.1 cannot marshal a script
  // block into the EnumWindows callback ("error while creating the pipeline"),
  // so the PowerShell side stays a bare static-method call.
  const source = `using System;
using System.Text;
using System.Runtime.InteropServices;
public class DshWinMsg {
  private delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassNameW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] private static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll", SetLastError = true)] private static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam, uint flags, uint timeout, out IntPtr result);
  public static IntPtr Find(uint targetPid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr hWnd, IntPtr lParam) {
      uint owner = 0;
      GetWindowThreadProcessId(hWnd, out owner);
      if (owner != targetPid) return true;
      StringBuilder text = new StringBuilder(128);
      GetClassNameW(hWnd, text, 128);
      if (text.ToString() == "Chrome_WidgetWin_1") { found = hWnd; return false; }
      return true;
    }, IntPtr.Zero);
    return found;
  }
  public static string Query(uint targetPid) {
    IntPtr h = Find(targetPid);
    if (h == IntPtr.Zero) return "none";
    IntPtr answer = IntPtr.Zero;
    IntPtr called = SendMessageTimeout(h, 0x0011, IntPtr.Zero, IntPtr.Zero, 0x0002, 4000, out answer);
    return "called:" + (called == IntPtr.Zero ? 0 : 1) + " answer:" + answer.ToInt64().ToString() + " hwnd:0x" + h.ToInt64().ToString("X");
  }
  public static string Send(uint targetPid, bool dryRun) {
    IntPtr h = Find(targetPid);
    if (h == IntPtr.Zero) return "none";
    if (dryRun) return "0x" + h.ToInt64().ToString("X");
    bool ended = PostMessage(h, 0x0016, (IntPtr)1, IntPtr.Zero);
    System.Threading.Thread.Sleep(300);
    bool closed = PostMessage(h, 0x0010, IntPtr.Zero, IntPtr.Zero);
    return "ended:" + (ended ? 1 : 0) + " close:" + (closed ? 1 : 0) + " hwnd:0x" + h.ToInt64().ToString("X");
  }
}`
  const call = mode === 'query'
    ? `[DshWinMsg]::Query(${pid})`
    : `[DshWinMsg]::Send(${pid}, ${mode === 'dry' ? '$true' : '$false'})`
  return `$source = @'
${source}
'@
Add-Type -TypeDefinition $source -Language CSharp
${call}`
}

/** Ask the shell to quit through its own session-end branch. */
async function requestGracefulQuit(pid, mode = 'send') {
  if (!Number.isInteger(pid) || pid <= 1) return { ok: false, reason: 'invalid-pid' }
  const script = windowMessageScript(pid, mode)
  let lastReason = 'no-shell'
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    let raw
    try {
      raw = execFileSync(shell, ['-NoProfile', '-NonInteractive', '-Command', script], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 20000,
      }).trim()
    } catch (error) {
      lastReason = `shell-error: ${String(error?.message ?? error).slice(0, 80)}`
      continue
    }
    if (raw === 'none') return { ok: false, reason: 'no-main-window' }
    if (mode === 'query') {
      const q = raw.match(/^called:(\d) answer:(-?\d+) hwnd:(0x[0-9a-f]+)$/i)
      if (q) return { ok: Number(q[1]) === 1, window: q[3], mode, answer: Number(q[2]) }
      lastReason = `unexpected-output: ${raw.slice(0, 80)}`
      continue
    }
    if (mode === 'dry') {
      if (/^0x[0-9a-f]+$/i.test(raw)) return { ok: true, window: raw, mode }
      lastReason = `unexpected-output: ${raw.slice(0, 80)}`
      continue
    }
    const sent = raw.match(/^ended:(\d) close:(\d) hwnd:(0x[0-9a-f]+)$/i)
    if (sent) {
      return Number(sent[1]) === 1
        ? { ok: true, window: sent[3], mode, closeSent: sent[2] === '1' }
        : { ok: false, reason: 'endsession-rejected', window: sent[3] }
    }
    lastReason = `unexpected-output: ${raw.slice(0, 80)}`
  }
  return { ok: false, reason: lastReason }
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

/** Escape one string for a PowerShell single-quoted literal. */
function psLiteral(value) {
  return `'${String(value).replace(/'/gu, "''")}'`
}

/**
 * List every live process started from the same executable path.
 * Snapshot-based cleanup cannot see children spawned after the snapshot, and
 * a stale plugin or runner child is exactly what makes the next launch fail
 * with EACCES on the session log or a profile file.
 */
async function listByExecutable(exe) {
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -ieq ${psLiteral(exe)} } | Select-Object ProcessId,ParentProcessId | ConvertTo-Json -Compress -Depth 2`
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
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
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
 * Backstop sweep: end every process started from the desktop executable,
 * except this helper and any pid the caller wants to keep. Runs after the
 * Host has had its chance to exit, so a still-live host counts as residual.
 * @returns {{ended: number, remaining: number[]}}
 */

/**
 * Read one live process's command line. Must run before that process ends:
 * a dead pid has no command line left to ask about.
 * @returns the raw string, or '' when the process is gone or WMI failed.
 */
async function readCommandLine(pid) {
  if (!Number.isInteger(pid) || pid <= 1) return ''
  const script = `Get-CimInstance Win32_Process -Filter "ProcessId = ${String(pid)}" | Select-Object -ExpandProperty CommandLine`
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    timeout: COMMAND_LINE_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  }
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const { stdout } = await execFileAsync(
        shell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        options,
      )
      return String(stdout).trim()
    } catch {
      /* try the next shell */
    }
  }
  return ''
}

/**
 * Split a Windows command line the way CommandLineToArgvW does, close enough
 * for replaying arguments into the same executable. Quotes group, a doubled
 * quote inside quotes is a literal quote, and a backslash escapes only a
 * quote that directly follows it.
 */
function splitWindowsCommandLine(commandLine) {
  const source = String(commandLine)
  const args = []
  let index = 0
  while (index < source.length) {
    while (index < source.length && source[index] === ' ') index += 1
    if (index >= source.length) break
    let current = ''
    let quoted = false
    while (index < source.length) {
      const ch = source[index]
      if (!quoted && (ch === ' ' || ch === '	')) break
      if (ch === '"' && quoted && source[index + 1] === '"') { current += '"'; index += 2; continue }
      if (ch === '"') { quoted = !quoted; index += 1; continue }
      if (ch === '\\' && source[index + 1] === '"') { current += '"'; index += 2; continue }
      current += ch
      index += 1
    }
    args.push(current)
  }
  return args
}

/**
 * Recover the arguments this instance was launched with, minus the executable
 * itself. The relaunched process must keep flags such as --user-data-dir, or a
 * second home silently shares the default profile.
 * @returns the argument list, or [] when it cannot be recovered safely.
 */
async function launchArgsFor(exe, pid) {
  if (typeof exe !== 'string' || exe.trim() === '') return []
  const commandLine = await readCommandLine(pid)
  if (commandLine === '') return []
  const parts = splitWindowsCommandLine(commandLine)
  if (parts.length <= 1) return []
  const head = path.basename(parts[0]).toLowerCase()
  if (head !== path.basename(exe).toLowerCase()) {
    note(`restart: launch arguments ignored; the command line starts with ${parts[0]}`)
    return []
  }
  return parts.slice(1)
}
/**
 * Which of these pids own a visible top-level window. A DSH a user started
 * from the desktop has one; renderers, runners and plugin children do not.
 * @returns the set of pids that own a main window.
 */
async function pidsWithMainWindow(pids) {
  const wanted = pids.filter((pid) => Number.isInteger(pid) && pid > 1)
  if (wanted.length === 0) return new Set()
  const script = `Get-Process -Id ${wanted.join(',')} -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -ExpandProperty Id`
  const options = {
    encoding: 'utf8',
    windowsHide: true,
    timeout: ORPHAN_LIST_TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  }
  for (const shell of ['powershell.exe', 'pwsh.exe']) {
    try {
      const { stdout } = await execFileAsync(
        shell,
        ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
        options,
      )
      const ids = new Set()
      for (const line of String(stdout).split(String.fromCharCode(10))) {
        const trimmed = line.trim()
        if (/^[0-9]+$/u.test(trimmed)) ids.add(Number(trimmed))
      }
      return ids
    } catch {
      /* try the next shell */
    }
  }
  return new Set()
}
async function sweepResiduals(exe, keepPids = []) {
  const ended = new Set()
  if (typeof exe !== 'string' || exe.trim() === '') return { ended: 0, remaining: [] }
  const keep = new Set([process.pid, ...keepPids.filter((pid) => Number.isInteger(pid) && pid > 1)])
  /** Pids that own a main window: a user-launched instance, never a residual child. */
  const windowed = new Set()
  let remaining = []
  for (let round = 1; round <= RESIDUAL_SWEEP_ROUNDS; round += 1) {
    let rows = []
    try {
      rows = await listByExecutable(exe)
    } catch (error) {
      note(`sweep: process list failed: ${String(error?.message ?? error)}`)
      return { ended: ended.size, remaining }
    }
    remaining = rows
      .map((row) => Number(row?.ProcessId))
      .filter((pid) => Number.isInteger(pid) && pid > 1 && !keep.has(pid) && alive(pid))
    if (remaining.length === 0) return { ended: ended.size, remaining: [] }
    for (const pid of await pidsWithMainWindow(remaining)) windowed.add(pid)
    if (windowed.size > 0) {
      note(`sweep: keeping ${String(windowed.size)} process(es) that own a main window: ${[...windowed].join(',')}`)
      remaining = remaining.filter((pid) => !windowed.has(pid))
      if (remaining.length === 0) return { ended: ended.size, remaining: [] }
    }
    note(`sweep: ${remaining.length} residual process(es) from the same executable: ${remaining.join(',')}`)
    for (const pid of remaining) if (killPid(pid)) ended.add(pid)
    await sleep(RESIDUAL_SWEEP_GAP_MS)
  }
  const still = []
  try {
    const rows = await listByExecutable(exe)
    for (const row of rows) {
      const pid = Number(row?.ProcessId)
      if (Number.isInteger(pid) && pid > 1 && !keep.has(pid) && !windowed.has(pid) && alive(pid)) still.push(pid)
    }
  } catch {
    /* keep the last known list */
  }
  return { ended: ended.size, remaining: still }
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

/**
 * End the snapshotted leftovers; keep the Host out of the cleanup.
 * Counts only processes that were actually alive when the pass started, so a
 * pid that exited on its own is not reported as a failed kill.
 * @returns {{ended: number, remaining: number[]}}
 */
async function cleanupOrphans(orphans, label, includeHost = true) {
  const main = Array.isArray(orphans?.main) ? orphans.main : []
  const host = Array.isArray(orphans?.host) ? orphans.host : []
  if (!includeHost && host.length > 0) {
    note(`${label}: host is still alive; skipping ${host.length} host child(ren)`)
  }
  const pids = [...new Set([...main, ...(includeHost ? host : [])])]
    .filter((pid) => Number.isInteger(pid) && pid > 1 && pid !== process.pid)
  const snapshot = pids.length
  const liveAtStart = pids.filter(alive)
  const alreadyGone = snapshot - liveAtStart.length
  let live = liveAtStart
  if (live.length === 0) {
    note(`${label}: no snapshot orphan processes left (${snapshot} in snapshot, all already gone)`)
    return { ended: 0, remaining: [] }
  }
  note(`${label}: ending ${live.length} live orphan process(es): ${live.join(',')}`)
  for (let round = 1; round <= ORPHAN_RETRY_ROUNDS && live.length > 0; round += 1) {
    for (const pid of live) killPid(pid)
    await sleep(round === 1 ? 300 : 500)
    live = liveAtStart.filter(alive)
    if (live.length > 0 && round < ORPHAN_RETRY_ROUNDS) {
      note(`${label}: retrying ${live.length} orphan process(es): ${live.join(',')}`)
    }
  }
  const ended = liveAtStart.length - live.length
  note(`${label}: ended ${ended}/${liveAtStart.length} live snapshot orphan process(es)${alreadyGone === 0 ? '' : ` (${alreadyGone} of ${snapshot} already gone)`}${live.length === 0 ? '' : `; ${live.length} still alive: ${live.join(',')}`}`)
  return { ended, remaining: live }
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
  const graceful = await requestGracefulQuit(handoff.mainPid)
  note(graceful.ok
    ? `shutdown: posted WM_ENDSESSION + WM_CLOSE at ${graceful.window}; waiting for the shell to quit on its own`
    : `shutdown: the graceful window request is unavailable (${graceful.reason})`)

  let mainGone = graceful.ok && await waitFor(() => !alive(handoff.mainPid), MAIN_EXIT_TIMEOUT_MS, 200)
  if (graceful.ok) {
    note(mainGone
      ? 'shutdown: the shell completed its own quit chain (nothing was force-killed)'
      : `shutdown: the shell is still alive after ${MAIN_EXIT_TIMEOUT_MS}ms; falling back to taskkill`)
  }
  if (!mainGone) {
    const killed = killPid(handoff.mainPid)
    note(killed ? `shutdown: taskkill /PID ${handoff.mainPid} /F ok` : `shutdown: taskkill reported an error for pid ${handoff.mainPid}`)
    mainGone = await waitFor(() => !alive(handoff.mainPid), MAIN_EXIT_TIMEOUT_MS, 200)
    note(mainGone ? 'shutdown: main process exited' : `shutdown: main process still alive after ${MAIN_EXIT_TIMEOUT_MS}ms`)
  }

  if (Number.isInteger(handoff.port) && handoff.port > 0) {
    const portFree = await waitFor(async () => !(await listening(handoff.port)), HOST_EXIT_TIMEOUT_MS, 300)
    note(portFree ? `shutdown: port ${handoff.port} released` : `shutdown: port ${handoff.port} still held`)
  }

  if (alive(handoff.hostPid)) {
    note(`shutdown: host ${handoff.hostPid} is still alive; ending it`)
    killPid(handoff.hostPid)
    await waitFor(() => !alive(handoff.hostPid), HOST_EXIT_TIMEOUT_MS, 200)
  } else {
    note('shutdown: host exited on its own')
  }
  await cleanupOrphans(handoff.orphans, 'shutdown', !alive(handoff.hostPid))
  const sweep = await sweepResiduals(handoff.exe)
  note(sweep.remaining.length === 0
    ? `shutdown: sweep ended ${sweep.ended}; no process from the app executable is left`
    : `shutdown: sweep ended ${sweep.ended}; ${sweep.remaining.length} process(es) still alive: ${sweep.remaining.join(',')}`)
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
  const rawExe = String(handoff.exe ?? '').trim()
  const exe = rawExe === '' ? '' : path.resolve(rawExe)

  // Before anything is ended: a dead pid has no command line left to read.
  const launchArgs = await launchArgsFor(exe, handoff.mainPid)
  note(launchArgs.length === 0
    ? 'restart: no launch arguments to relay'
    : `restart: relaying ${String(launchArgs.length)} launch argument(s): ${launchArgs.join(' ')}`)

  const graceful = await requestGracefulQuit(handoff.mainPid)
  note(graceful.ok
    ? `restart: posted WM_ENDSESSION + WM_CLOSE at ${graceful.window}; waiting for the shell to quit on its own`
    : `restart: the graceful window request is unavailable (${graceful.reason})`)

  let mainGone = graceful.ok && await waitFor(() => !alive(handoff.mainPid), MAIN_EXIT_TIMEOUT_MS, 200)
  if (graceful.ok) {
    note(mainGone
      ? 'restart: the shell completed its own quit chain (nothing was force-killed)'
      : `restart: the shell is still alive after ${MAIN_EXIT_TIMEOUT_MS}ms; falling back to taskkill`)
  }
  if (!mainGone) {
    const killed = killPid(handoff.mainPid)
    note(killed ? `restart: taskkill /PID ${handoff.mainPid} /F ok` : `restart: taskkill reported an error for pid ${handoff.mainPid}`)
    mainGone = await waitFor(() => !alive(handoff.mainPid), MAIN_EXIT_TIMEOUT_MS, 200)
    note(mainGone ? 'restart: main process exited' : `restart: main process still alive after ${MAIN_EXIT_TIMEOUT_MS}ms`)
  }

  // The host and its plugin children are what linger between runs. Give the
  // host its graceful exit first; only escalate when it is still there.
  const hostGone = await waitFor(() => !alive(handoff.hostPid), HOST_EXIT_TIMEOUT_MS, 250)
  note(hostGone ? 'restart: host exited on its own' : `restart: host ${handoff.hostPid} still alive after ${HOST_EXIT_TIMEOUT_MS}ms; ending it`)
  if (!hostGone && alive(handoff.hostPid)) {
    killPid(handoff.hostPid)
    await waitFor(() => !alive(handoff.hostPid), 5000, 200)
  }

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

  await cleanupOrphans(handoff.orphans, 'restart', !alive(handoff.hostPid))
  let sweep = await sweepResiduals(exe)
  note(sweep.remaining.length === 0
    ? `restart: sweep ended ${sweep.ended}; clean before relaunch`
    : `restart: sweep ended ${sweep.ended}; ${sweep.remaining.length} still alive before relaunch: ${sweep.remaining.join(',')}`)

  // Give the socket and the filesystem a moment to settle before relaunching.
  await sleep(portFree ? 800 : 1500)

  if (rawExe === '') {
    note('restart: no executable in the handoff; aborting')
    alertUser('重启失败：交接信息里没有应用路径。请手动启动 DeepSeek Harness。')
    return
  }

  // Windows paths may contain Chinese, spaces, or other non-ASCII characters.
  // Keep the path as a single argv value and let Node/CreateProcessW handle it;
  // never build a shell command string.
  if (!fs.existsSync(exe) || !fs.statSync(exe).isFile()) {
    note(`restart: executable does not exist: ${exe}`)
    alertUser(`重启失败：找不到应用路径。\n\n${exe}\n\n请手动启动 DeepSeek Harness。`)
    return
  }
  const exeDir = path.dirname(exe)

  const keepProxy = String(process.env.DSH_POWER_MENU_KEEP_PROXY ?? '') === '1'
  if (keepProxy) note('restart: DSH_POWER_MENU_KEEP_PROXY=1; keeping the inherited proxy variables')
  const env = { ...process.env }
  for (const key of Object.keys(env)) {
    const upper = key.toUpperCase()
    if (!STALE_ENV_KEYS.has(upper)) continue
    if (keepProxy && PROXY_ENV_KEYS.has(upper)) continue
    delete env[key]
  }

  let childPid = null
  for (let attempt = 1; attempt <= RELAUNCH_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      note(`restart: attempt ${attempt}/${RELAUNCH_ATTEMPTS} in 1500ms`)
      await sleep(1500)
    }
    let child = null
    try {
      child = spawn(exe, launchArgs, {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
        cwd: exeDir,
        env,
      })
      child.on('error', (error) => note(`restart: spawn error: ${String(error?.message ?? error)}`))
      child.unref()
      note(`restart: relaunched ${exe} as pid ${String(child.pid)}${launchArgs.length === 0 ? '' : ` with ${String(launchArgs.length)} argument(s)`}`)
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

    // A timed-out attempt can leave its own stuck process behind. End it and
    // sweep the tree again before the next try instead of returning with the
    // residue still in place — that residue is what made the next click fail.
    if (attempt < RELAUNCH_ATTEMPTS) {
      if (Number.isInteger(child.pid) && alive(child.pid)) killPid(child.pid)
      await sleep(500)
      sweep = await sweepResiduals(exe)
      note(`restart: retry sweep ended ${sweep.ended}; ${sweep.remaining.length === 0 ? 'clean' : `${sweep.remaining.length} still alive: ${sweep.remaining.join(',')}`}`)
    }
  }

  if (childPid === null) {
    note('restart: application did not come back with a usable window')
    const shown = alertUser(`重启失败：DeepSeek Harness 没有出现可用的主窗口。\n\n残留进程已尽力清理，仍失败请手动启动应用。\n日志：${LOG_PATH}`)
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
  if (process.argv[2] === '--sweeptest') {
    const target = process.argv[3]
    const result = await sweepResiduals(target)
    console.log(JSON.stringify(result))
    process.exitCode = result.remaining.length === 0 ? 0 : 1
    return
  }
  if (process.argv[2] === '--findwindow') {
    const result = await requestGracefulQuit(Number(process.argv[3]), 'dry')
    console.log(JSON.stringify(result))
    return
  }
  if (process.argv[2] === '--querytest') {
    const result = await requestGracefulQuit(Number(process.argv[3]), 'query')
    console.log(JSON.stringify(result))
    return
  }
  if (process.argv[2] === '--argstest') {
    const pid = Number(process.argv[3])
    const targetExe = typeof process.argv[4] === 'string' ? process.argv[4] : ''
    const commandLine = await readCommandLine(pid)
    const parts = splitWindowsCommandLine(commandLine)
    const args = await launchArgsFor(targetExe, pid)
    console.log(JSON.stringify({
      pid,
      exe: targetExe,
      lineLength: commandLine.length,
      head: parts.length === 0 ? '' : parts[0],
      count: parts.length,
      args,
    }))
    return
  }
  if (process.argv[2] === '--windowlist') {
    const pids = String(process.argv[3] ?? '').split(',').map((value) => Number(value.trim())).filter((pid) => Number.isInteger(pid) && pid > 1)
    const windowed = await pidsWithMainWindow(pids)
    console.log(JSON.stringify({ asked: pids, windowed: Array.from(windowed) }))
    return
  }
  if (process.argv[2] === '--processtest') {
    const exe = process.argv[3]
    const rows = await listByExecutable(exe)
    console.log(JSON.stringify(rows))
    return
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

  const pluginVersion = readPluginVersion()

  note(`helper started: helper=${process.pid} host=${String(handoff.hostPid)} main=${String(handoff.mainPid)} mode=${String(handoff.mode)} plugin=${pluginVersion}`)

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
