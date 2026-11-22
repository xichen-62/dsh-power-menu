/**
 * dsh-power-menu — host half.
 *
 * Adds three loopback-only HTTP routes used by the client-side power menu:
 *
 *   POST /api/dsh-power-menu/shutdown  — quit the whole desktop app
 *   POST /api/dsh-power-menu/restart   — quit, then relaunch the app
 *   GET  /api/dsh-power-menu/health    — whether this is the desktop build
 *   GET  /api/dsh-power-menu/plan      — target/refusal report, no side effects
 *   GET  /api/dsh-power-menu/tasks     — live work a transition would interrupt
 *
 * The host process is a child of the Electron main process in the desktop
 * build, so it cannot call app.quit() / app.relaunch() itself. The actual
 * handoff is performed by a detached helper (lib/helper.cjs) which kills only
 * the Electron main process (no /T). Killing the main closes the IPC channel;
 * the host then runs its own graceful `application.shutdown` and flushes the
 * session logs. For a restart the helper waits for the port to be released
 * and relaunches the same executable with a clean environment.
 */
import { spawn } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-power-menu'
export const inject = ['webServer']

const BASE = '/api/dsh-power-menu'
const HELPER = fileURLToPath(new URL('./helper.cjs', import.meta.url))
const STATE_DIR = join(homedir(), '.dsh', 'dsh-power-menu')
const LOG_PATH = join(STATE_DIR, 'power-menu.log')

/** At-most-once latch: restart and shutdown both end this process. */
let pending = null

function note(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    appendFileSync(LOG_PATH, `${new Date().toISOString()} ${line}\n`, 'utf8')
  } catch {
    /* diagnostics must never break the action */
  }
}

function json(res, status, payload) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  })
  res.end(JSON.stringify(payload))
}

/** Whether this host is the desktop build's child (Electron main as parent). */
function desktopTarget() {
  if (process.env.ELECTRON_RUN_AS_NODE !== '1') return null
  const mainPid = process.ppid
  if (!Number.isInteger(mainPid) || mainPid <= 1) return null
  const exe = process.execPath
  if (typeof exe !== 'string' || exe === '') return null
  const base = basename(exe).toLowerCase()
  // A plugin-spawned node.exe inherits ELECTRON_RUN_AS_NODE=1. Never mistake
  // it for the desktop executable: killing it would be a silent misfire.
  if (base === 'node.exe' || base === 'node') return null
  return { mainPid, exe, hostPid: process.pid }
}

function resolvePort(ctx) {
  try {
    const port = ctx.webServer?.port
    if (Number.isInteger(port) && port > 0) return port
  } catch {
    /* fall through */
  }
  try {
    const address = ctx.webServer?.server?.address?.()
    if (address !== null && typeof address === 'object' && Number.isInteger(address.port) && address.port > 0) {
      return address.port
    }
  } catch {
    /* fall through */
  }
  return null
}

/**
 * Destructive routes are fenced the same way DSH fences its own API:
 * loopback socket, loopback Host header, no cross-site fetch, and an Origin
 * whose host:port is this server. DSH's renderer may use the `dsh-app:`
 * scheme, so protocol equality is deliberately not required.
 */
function trusted(req) {
  const address = req.socket?.remoteAddress
  if (address !== '127.0.0.1' && address !== '::1' && address !== '::ffff:127.0.0.1') return false
  const { host, origin, 'sec-fetch-site': secFetchSite } = req.headers
  if (typeof host !== 'string') return false
  let hostUrl
  try {
    hostUrl = new URL(`http://${host}`)
  } catch {
    return false
  }
  const hostname = hostUrl.hostname
  if (hostname !== '127.0.0.1' && hostname !== '::1' && hostname !== '[::1]' && hostname !== 'localhost') return false
  if (secFetchSite === 'cross-site') return false
  // The desktop shell can omit Origin entirely. 0.1.16 accepted that and the
  // real button worked; rejecting it here caused every click to 403. The
  // loopback socket + loopback Host checks still apply, and a local process
  // that can omit Origin can already taskkill the app, so this is the same
  // local-trust boundary documented in the README.
  if (origin === undefined) return true
  if (typeof origin !== 'string' || origin === 'null') return false
  try {
    const originUrl = new URL(origin)
    // `dsh-app://127.0.0.1:<port>` is the normal desktop renderer origin;
    // requiring an exact http/https protocol here made every real button
    // click 403. The host and port still pin the request to this server.
    return originUrl.host === hostUrl.host
  } catch {
    return false
  }
}

/** One job as the confirmation dialog shows it. */
function jobRow(job) {
  return {
    id: String(job.id ?? ''),
    kind: String(job.kind ?? ''),
    label: String(job.label ?? job.kind ?? ''),
    status: String(job.status ?? ''),
    progress: typeof job.progress === 'string' ? job.progress : '',
    startedAt: Number.isFinite(job.startedAt) ? job.startedAt : null,
  }
}

function isLiveJob(job) {
  return job !== null && typeof job === 'object' && (job.status === 'running' || job.status === 'stopping')
}

function lookup(ctx, name) {
  try {
    if (typeof ctx.get === 'function') {
      const direct = ctx.get(name)
      if (direct !== undefined && direct !== null) return direct
    }
  } catch {
    /* fall through to the root lookup */
  }
  try {
    const root = ctx.root
    return typeof root?.get === 'function' ? root.get(name) : undefined
  } catch {
    return undefined
  }
}

/**
 * Snapshot of the work a power transition would interrupt.
 *
 * Mirrors the desktop build's own quit inspection (`installDesktopQuitInspection`
 * in dsh-desktop-host): a session counts as busy when its agent is running,
 * when its inbox still holds queued or steering messages, or when it owns a
 * live job. The dialog therefore appears exactly when the official quit path
 * would also consider the app busy. Every service is optional: an older or
 * non-desktop host answers `available: false` and the button keeps its
 * one-click behavior.
 */
function collectTasks(ctx) {
  const agents = lookup(ctx, 'agents')
  if (agents === null || typeof agents !== 'object' || typeof agents.list !== 'function') {
    return { available: false, active: false, total: 0, sessions: [], ownerless: [] }
  }
  const jobs = lookup(ctx, 'jobs')
  const titles = lookup(ctx, 'sessionTitle')

  const listJobs = (owner) => {
    try {
      const rows = typeof jobs?.list === 'function' ? jobs.list(owner) : undefined
      return Array.isArray(rows) ? rows : []
    } catch {
      return []
    }
  }

  const titleOf = (agent) => {
    try {
      const snapshot = typeof titles?.get === 'function' ? titles.get(agent.session) : undefined
      return typeof snapshot?.title === 'string' ? snapshot.title : ''
    } catch {
      return ''
    }
  }

  let live = []
  try {
    const rows = agents.list()
    if (Array.isArray(rows)) live = rows
  } catch {
    live = []
  }

  const sessions = []
  for (const agent of live) {
    if (agent === null || typeof agent !== 'object') continue
    const running = agent.status === 'running'
    const queuedTurn = Array.isArray(agent.inbox?.nextTurn) ? agent.inbox.nextTurn.length : 0
    const queuedStep = Array.isArray(agent.inbox?.nextStep) ? agent.inbox.nextStep.length : 0
    // `jobs.list(caller)` also returns every unowned job; keep only this session's own so an
    // ownerless background task is listed once, under `ownerless`, instead of under every row.
    const owned = listJobs(agent.id)
      .filter((job) => job.owner !== undefined && job.owner !== null && String(job.owner) === String(agent.id))
      .filter(isLiveJob)
      .map(jobRow)
    const queued = queuedTurn + queuedStep
    if (!running && queued === 0 && owned.length === 0) continue
    sessions.push({
      id: String(agent.id ?? ''),
      title: titleOf(agent),
      status: running ? 'running' : 'idle',
      queued,
      jobs: owned,
    })
  }

  // A live job without a live owner would still be terminated by the transition.
  const ownerless = listJobs(undefined)
    .filter((job) => isLiveJob(job) && (job.owner === undefined || job.owner === null))
    .map(jobRow)

  return {
    available: true,
    active: sessions.length > 0 || ownerless.length > 0,
    total: sessions.length + ownerless.length,
    sessions,
    ownerless,
  }
}

/**
 * Ask the composition's `connection` service to fence this request, the way
 * every official host route does (`dsh-host-open-in-app` opens each handler
 * with `ctx.connection.requestRejection(req)`). It adds what a hand-rolled
 * Origin check cannot: the Host/Origin fence against DNS rebinding, plus the
 * browser auth cookie — the desktop shell forwards renderer requests with
 * that cookie attached and no Origin header at all.
 *
 * Returns true when the fence answered the request itself. A composition with
 * no `connection` service (older DSH builds) falls through to `trusted()`.
 */
function fenced(ctx, req, res, sub) {
  const connection = lookup(ctx, 'connection')
  if (connection === undefined || typeof connection.requestRejection !== 'function') return false
  let rejection
  try {
    rejection = connection.requestRejection(req)
  } catch (error) {
    note(`connection fence unavailable: ${error instanceof Error ? error.message : String(error)}`)
    return false
  }
  if (rejection !== 401 && rejection !== 403) return false
  note(`fenced ${sub}: ${String(rejection)} host=${JSON.stringify(req.headers?.host ?? null)} origin=${JSON.stringify(req.headers?.origin ?? null)}`)
  res.statusCode = rejection
  res.end()
  return true
}

/**
 * Write the handoff file and start the detached helper.
 * @param {'shutdown'|'restart'} mode
 * @param {object} ctx
 */
function schedule(mode, ctx) {
  if (pending !== null) {
    return { ok: false, status: 409, error: `power transition already in progress: ${pending}` }
  }
  const target = desktopTarget()
  if (target === null) {
    return {
      ok: false,
      status: 409,
      error: '仅支持 DeepSeek Harness 桌面版（当前是 dsh web，请用终端里的进程管理方式）',
    }
  }
  if (!existsSync(HELPER)) return { ok: false, status: 500, error: `helper missing: ${HELPER}` }

  pending = mode
  try {
    mkdirSync(STATE_DIR, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-').slice(0, 23)
    const handoffPath = join(STATE_DIR, `handoff-${mode}-${stamp}.json`)
    const logPath = join(STATE_DIR, `helper-${mode}-${stamp}.log`)
    const handoff = {
      mode,
      mainPid: target.mainPid,
      hostPid: target.hostPid,
      exe: target.exe,
      port: resolvePort(ctx),
      delayMs: 1200,
      logPath,
      handoffPath,
      startedAt: new Date().toISOString(),
    }
    writeFileSync(handoffPath, JSON.stringify(handoff, null, 2), 'utf8')
    note(`${mode}: scheduled main=${String(target.mainPid)} host=${String(target.hostPid)} exe=${target.exe} port=${String(handoff.port)} log=${logPath}`)

    const helper = spawn(process.execPath, [HELPER, handoffPath], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      cwd: dirname(HELPER),
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    })
    helper.on('error', (error) => {
      note(`${mode}: helper spawn error: ${String(error?.message ?? error)}`)
      pending = null
    })
    helper.unref()
    note(`${mode}: helper pid=${String(helper.pid)}`)
    return { ok: true, status: 202, mode }
  } catch (error) {
    pending = null
    const message = error instanceof Error ? error.message : String(error)
    note(`${mode}: failed to schedule: ${message}`)
    return { ok: false, status: 500, error: message }
  }
}

export function apply(ctx) {
  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix',
    path: BASE,
    handler: (req, res) => {
      let sub = '/'
      try {
        sub = new URL(req.url ?? '/', 'http://x').pathname.slice(BASE.length).replace(/\/+$/u, '') || '/'
      } catch {
        /* keep '/' */
      }

      if (fenced(ctx, req, res, sub)) return

      if (sub === '/health') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        json(res, 200, {
          ok: true,
          desktop: desktopTarget() !== null,
          pending,
        })
        return
      }

      if (sub === '/tasks') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        if (!trusted(req)) {
          note(`forbidden tasks: origin=${JSON.stringify(req.headers.origin ?? null)} host=${JSON.stringify(req.headers.host ?? null)}`)
          return json(res, 403, { ok: false, error: 'forbidden: untrusted power request' })
        }
        json(res, 200, { ok: true, ...collectTasks(ctx) })
        return
      }

      if (sub === '/plan') {
        if (req.method !== 'GET') return json(res, 405, { ok: false, error: 'method not allowed' })
        const target = desktopTarget()
        const reasons = []
        if (target === null) reasons.push('not a desktop host, or the executable looks like node')
        if (!existsSync(HELPER)) reasons.push(`helper missing: ${HELPER}`)
        if (target !== null && !existsSync(target.exe)) reasons.push(`executable missing: ${target.exe}`)
        json(res, 200, {
          ok: reasons.length === 0,
          desktop: target !== null,
          target,
          helper: HELPER,
          logPath: LOG_PATH,
          pending,
          reasons,
        })
        return
      }

      if (sub !== '/shutdown' && sub !== '/restart') {
        return json(res, 404, { ok: false, error: `no dsh-power-menu endpoint ${sub}` })
      }
      if (req.method !== 'POST') return json(res, 405, { ok: false, error: 'method not allowed' })
      if (!trusted(req)) {
        note(`forbidden: origin=${JSON.stringify(req.headers.origin ?? null)} host=${JSON.stringify(req.headers.host ?? null)} sec=${JSON.stringify(req.headers['sec-fetch-site'] ?? null)}`)
        return json(res, 403, { ok: false, error: 'forbidden: untrusted power request' })
      }

      const result = schedule(sub === '/restart' ? 'restart' : 'shutdown', ctx)
      if (!result.ok) return json(res, result.status ?? 500, result)
      json(res, result.status ?? 202, result)
    },
  }), 'dsh-power-menu: /api/dsh-power-menu routes')
  const connection = lookup(ctx, 'connection')
  note(`connection fence: ${connection !== undefined && typeof connection.requestRejection === 'function' ? 'available' : 'unavailable (falling back to the loopback check)'}`)
}

// Some installers/loaders unwrap ESM imports through `default`; keep both
// shapes so a Git install behaves like the locally linked package. The
// default must be the full plugin object, not the bare `apply` function:
// Cordis reads `inject` from the unwrapped plugin, and losing it throws
// `cannot get property "webServer" without inject`.
export default { name, inject, apply }
