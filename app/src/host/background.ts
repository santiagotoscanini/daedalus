import { ensureScheduler, stopScheduler } from '../core/builds/scheduler'
import { reportEnvOnce } from './env'
import { ensureGatewaySync, stopGatewaySync } from './gateway-sync'
import { ensureIconExport, stopIconExport } from './workspace-icons'

// The process's own work, the part no request asks for: the environment's
// startup report, the build scheduler (core/builds/scheduler.ts), the gateway
// sync's five-minute run, the workspace icons santree shows, the controller
// link's minute, and the break-glass login's setup token.
//
// `start()` runs once per process, when it is ready to serve: from server.mjs
// once the listener is up (through src/server.ts, the bundle's entry), and in
// dev from vite.config.ts's `daedalus:background` plugin, through the SSR
// environment's runner — the module graph requests use. `stop()` runs at
// shutdown. Both are idempotent; the started flag sits on globalThis because
// Vite re-evaluates this file on a save while the process lives on.

/** The controller link's cadence: re-dial a controller that restarted, keep the machines' last-known facts. */
export const CONTROLLER_LINK_EVERY_MS = 60_000

const SLOT = Symbol.for('daedalus.background')
type Slot = { link: ReturnType<typeof setInterval> }
const holder = globalThis as unknown as Record<symbol, Slot | undefined>

/** One controller tick (host/controller/nodes.ts). Never throws, never awaited by anything that serves. */
function controllerLink(): void {
  void Promise.all([import('./controller/nodes'), import('../core/ctx')])
    .then(async ([m, c]) => m.ensureControllerLink(await c.makeCtx()))
    .catch(() => undefined)
}

/**
 * Start the background work. A required environment variable that is missing
 * throws here, before anything starts: the process should not serve on it.
 */
export function start(): void {
  if (holder[SLOT] !== undefined) return
  reportEnvOnce()
  ensureScheduler()
  ensureGatewaySync()
  ensureIconExport()
  const link = setInterval(controllerLink, CONTROLLER_LINK_EVERY_MS)
  link.unref()
  holder[SLOT] = { link }
  controllerLink()
  // Minted and printed only while site.json turns the login on and no admin exists.
  void import('../core/local-login').then((m) => m.announceSetupTokenOnce()).catch(() => {})
}

/** Stop every timer `start()` armed. Work already running finishes on its own. */
export function stop(): void {
  const slot = holder[SLOT]
  if (slot === undefined) return
  delete holder[SLOT]
  clearInterval(slot.link)
  stopScheduler()
  stopGatewaySync()
  stopIconExport()
}
