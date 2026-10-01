import { readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { env } from '../env'
import type { Command, ControllerRotateParams, ModelAction, SessionAction } from './generated'
import {
  API_VERSION,
  type ClaudeRosterGet,
  type ClaudeStatus,
  type CommandOk,
  ControllerError,
  type ControllerInfo,
  type ControllerNode,
  type ControllerNodeDetail,
  claudeRosterGet,
  claudeSessionSent,
  claudeStatus,
  commandOk,
  controllerRotated,
  type DesiredNode,
  type HelloOk,
  helloOk,
  MAX_LINE,
  type NodeClaudeAnswer,
  type NodeClaudeRosterAnswer,
  type NodeProvidersAnswer,
  type NodeTelemetryAnswer,
  nodeClaudeAnswer,
  nodeClaudeRosterAnswer,
  nodeDetail,
  nodeLeftId,
  nodePolicyRequest,
  nodeProvidersAnswer,
  nodesList,
  nodeTelemetryAnswer,
  parseLine,
  providerModelSent,
  type Queued,
  queued,
  type RootRun,
  requestLine,
  rootRunOk,
  type SessionHostStatus,
  type SessionSent,
  type SetDesiredOk,
  type SystemInfo,
  santreeStatus,
  sessionQueued,
  setDesiredOk,
  systemInfo,
  type TelemetryGet,
  telemetryGet,
} from './wire'

// The app's one door to the controller: the agent on the box, over the unix
// socket nix mounts into this container (CONTROLLER_SOCKET). The protocol is
// agent/README.md "Controller mode" and agent/src/api/: newline-delimited
// JSON, `hello` first, answers matched by `id` because the agent runs
// requests concurrently.
//
// ONE connection per process. The agent serves at most 16 at once and turns
// the seventeenth away, so a connection per request — or one leaked per Vite
// reload — would lock the app out of its own box. The live client is kept on
// globalThis, and a re-evaluated copy of this module (HMR) closes the
// previous copy's before it takes the slot. It connects on the first call,
// not at import; a connection that closes is re-dialled by the next call,
// and a dial that fails holds off the next for a backoff that doubles to
// ten seconds, answering `unreachable` meanwhile rather than hammering a
// controller that is down.
//
// No retry ladder: the socket is local, so a request either answers within
// the timeout or the controller is wedged, and asking again would only queue
// behind the first.

/** One call, and the hello, answer within this long or fail `timeout`. */
const TIMEOUT_MS = 3_000
/**
 * How long the controller waits for a machine to acknowledge a verb it relays
 * (`nodes.command`, `nodes.claude_session`, `nodes.provider_model`): the
 * agent's `ACK_TIMEOUT` in agent/src/link/controller/registry.rs, restated.
 * Those calls wait this plus the client's own timeout, so the controller's
 * answer — the ack, or its own `timeout` — is what the caller hears.
 */
export const MACHINE_ACK_MS = 5_000
/** The first wait after a failed dial; doubled per failure, up to the max. */
const BACKOFF_MS = 250
const BACKOFF_MAX_MS = 10_000

/**
 * How the one connection stands, for the shell's banner and the boards that
 * would otherwise read "no answer" as a verdict about the machines. `down`
 * holds from the first failure after the last good connection until the next
 * one, re-dials included, so it does not flicker between attempts.
 */
export type ControllerLink =
  | { state: 'idle' }
  | { state: 'not_configured' }
  | { state: 'connecting'; since: string }
  | { state: 'connected'; since: string }
  | { state: 'down'; since: string; error: string }

export type ControllerClient = {
  systemInfo: () => Promise<SystemInfo>
  claudeStatus: () => Promise<ClaudeStatus>
  claudeRestart: () => Promise<Queued>
  claudeRoster: () => Promise<ClaudeRosterGet>
  /** One verb on one of the controller's sessions; the roster reports how it went. */
  claudeSession: (action: SessionAction, id: string) => Promise<SessionSent>
  telemetryGet: () => Promise<TelemetryGet>
  nodesList: () => Promise<ControllerNode[]>
  nodesGet: (id: string) => Promise<ControllerNodeDetail>
  nodesTelemetry: (id: string) => Promise<NodeTelemetryAnswer>
  /** What the machine's agent read from its providers, as it last pushed it. */
  nodesProviders: (id: string) => Promise<NodeProvidersAnswer>
  /**
   * One residency verb on a machine's provider, run by its agent on its own
   * loopback: only ever from an admin's click. The outcome rides the next
   * providers document under the returned `request`.
   */
  nodesProviderModel: (
    id: string,
    verb: {
      kind: string
      action: ModelAction
      model: string
      pinned?: boolean
      replacing?: string
    },
  ) => Promise<{ request: string }>
  nodesClaude: (id: string) => Promise<NodeClaudeAnswer>
  nodesClaudeRoster: (id: string) => Promise<NodeClaudeRosterAnswer>
  /** One verb on one of a machine's sessions: only ever from an admin's click. */
  nodesClaudeSession: (id: string, action: SessionAction, session: string) => Promise<SessionSent>
  /** The app's COMPLETE set of decided keys (./nodes.ts builds it). */
  nodesSetDesired: (nodes: DesiredNode[]) => Promise<SetDesiredOk>
  /** A one-shot instruction to one machine: only ever from an admin's click. */
  nodesCommand: (id: string, command: Command) => Promise<CommandOk>
  /**
   * A new controller key, the old one retired after the grace: only ever from
   * an admin's confirmed click. `unavailable` while a rotation runs.
   */
  controllerRotate: (p: ControllerRotateParams) => Promise<ControllerInfo>
  /**
   * One root verb, run by the root helper through the controller (agent
   * src/root/): only ever from an admin's click. Answers when the verb's unit
   * has finished, so it takes its own wait; `status` is the read-only one.
   */
  rootRun: (
    verb: string,
    selectors?: Record<string, string>,
    waitMs?: number,
    payload?: string,
  ) => Promise<RootRun>
  /** The session host (`santree.status`); `unavailable` on a box without one. */
  santreeStatus: () => Promise<SessionHostStatus>
  /** The last hello's answer, or null while not connected. */
  hello: () => HelloOk | null
  /** How the connection stands. Read from memory: it never dials. */
  link: () => ControllerLink
  /** End this client for good: the connection goes, and later calls fail `closed`. */
  close: () => void
}

type Options = {
  /** The socket, or undefined when the box binds none (`not_configured`). */
  path: string | undefined
  /** Who this is, for the agent's log: `daedalus/<version>`. */
  client: string
  timeoutMs?: number
  backoffMs?: number
  backoffMaxMs?: number
  /**
   * Called after every connection's hello, the first and each re-dial: the
   * controller keeps nothing across its own restart, so this is where the
   * app hands it the desired set again. Its failure is its own business.
   */
  onConnect?: (client: ControllerClient) => void
  /**
   * Given, every connection subscribes to the controller's events
   * (`events.subscribe`) and hands each here: best effort, as the agent sends
   * them — an event says what moved, and a method reads the picture.
   */
  onEvent?: (event: string, payload: unknown) => void
}

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: ControllerError) => void
  timer: ReturnType<typeof setTimeout>
}

/** An open, hello'd connection. */
type Live = { socket: Socket; hello: HelloOk }

/**
 * A client over one socket path. The process's own is `controller()`; the
 * tests make theirs against a fake server.
 */
export function createControllerClient(opts: Options): ControllerClient {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
  const relayedMs = MACHINE_ACK_MS + timeoutMs
  const backoffMs = opts.backoffMs ?? BACKOFF_MS
  const backoffMaxMs = opts.backoffMaxMs ?? BACKOFF_MAX_MS

  let live: Live | null = null
  let dialing: Promise<Live> | null = null
  let closed = false
  let failures = 0
  let retryAt = 0
  let lastError: ControllerError | null = null
  let connectedAt = 0
  let dialStartedAt = 0
  /** Since when, and why, no connection has held; null while one does or none was tried. */
  let down: { since: number; error: ControllerError } | null = null
  let nextId = 1
  const pending = new Map<number, Pending>()

  const failAll = (e: ControllerError) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      pending.delete(id)
      p.reject(e)
    }
  }

  /** Write one request on `socket` and wait for its answer. */
  const send = (
    socket: Socket,
    m: string,
    p?: Record<string, unknown>,
    waitMs: number = timeoutMs,
  ): Promise<unknown> =>
    new Promise((resolve, reject) => {
      if (socket.destroyed) {
        reject(new ControllerError('closed', 'the controller connection is gone'))
        return
      }
      const id = nextId++
      const timer = setTimeout(() => {
        pending.delete(id)
        reject(
          new ControllerError('timeout', `the controller did not answer ${m} within ${waitMs} ms`),
        )
      }, waitMs)
      pending.set(id, { resolve, reject, timer })
      socket.write(requestLine(id, m, p))
    })

  const dial = (path: string): Promise<Live> =>
    new Promise<Live>((resolve, reject) => {
      const socket = createConnection(path)
      // Never what keeps the process alive: a one-off script ends, and the
      // dev server's lifetime is not this socket's to extend.
      socket.unref()
      let chunks: Buffer[] = []
      let buffered = 0
      let settled = false

      const drop = (e: ControllerError) => {
        socket.destroy()
        if (live?.socket === socket) {
          live = null
          down = { since: Date.now(), error: e }
        }
        failAll(e)
        if (!settled) {
          settled = true
          reject(e)
        }
      }

      const onLine = (line: Buffer) => {
        if (line.length === 0) return
        let msg: ReturnType<typeof parseLine>
        try {
          msg = parseLine(line.toString('utf8'))
        } catch (e) {
          drop(e instanceof ControllerError ? e : new ControllerError('protocol', String(e)))
          return
        }
        if (msg.kind === 'event') {
          // A handler's failure is its own; it never costs the connection.
          try {
            opts.onEvent?.(msg.e, msg.p)
          } catch (e) {
            console.warn(`controller: the ${msg.e} event's handler failed: ${String(e)}`)
          }
          return
        }
        if (msg.kind === 'err' && msg.id === null) {
          // Not an answer to anything: the agent says why before it closes
          // (forbidden, busy, too_large) — the connection's error, not a call's.
          drop(msg.error)
          return
        }
        const p = pending.get(msg.id as number)
        if (p === undefined) return // answered after its timeout
        pending.delete(msg.id as number)
        clearTimeout(p.timer)
        if (msg.kind === 'ok') p.resolve(msg.ok)
        else p.reject(msg.error)
      }

      socket.on('data', (chunk: Buffer) => {
        let rest = chunk
        for (;;) {
          const nl = rest.indexOf(10)
          if (nl === -1) {
            chunks.push(rest)
            buffered += rest.length
            if (buffered > MAX_LINE) {
              drop(
                new ControllerError(
                  'too_large',
                  `the controller wrote a line over ${MAX_LINE} bytes`,
                ),
              )
            }
            return
          }
          const tail = rest.subarray(0, nl)
          if (buffered + tail.length > MAX_LINE) {
            drop(
              new ControllerError(
                'too_large',
                `the controller wrote a line over ${MAX_LINE} bytes`,
              ),
            )
            return
          }
          const line = chunks.length === 0 ? tail : Buffer.concat([...chunks, tail])
          chunks = []
          buffered = 0
          onLine(line)
          if (socket.destroyed) return
          rest = rest.subarray(nl + 1)
        }
      })
      socket.on('error', (e: NodeJS.ErrnoException) => {
        drop(
          settled
            ? new ControllerError('closed', `the controller connection failed: ${e.message}`)
            : unreachable(path, e),
        )
      })
      socket.on('close', () => {
        drop(new ControllerError('closed', 'the controller closed the connection'))
      })
      socket.on('connect', () => {
        send(socket, 'hello', { api: API_VERSION, client: opts.client })
          .then((ok) => {
            if (settled) return
            settled = true
            const l = { socket, hello: helloOk(ok) }
            live = l
            resolve(l)
            // The events belong to the connection, so each one subscribes.
            if (opts.onEvent !== undefined) {
              send(socket, 'events.subscribe').catch((e: unknown) => {
                console.warn(`controller: no events on this connection: ${String(e)}`)
              })
            }
          })
          .catch((e: unknown) => {
            drop(e instanceof ControllerError ? e : new ControllerError('protocol', String(e)))
          })
      })
    })

  const connection = (): Promise<Live> => {
    if (closed) return Promise.reject(new ControllerError('closed', 'this client was closed'))
    if (live !== null && !live.socket.destroyed) return Promise.resolve(live)
    if (dialing !== null) return dialing
    const path = opts.path
    if (path === undefined) {
      return Promise.reject(
        new ControllerError('not_configured', 'this box binds no CONTROLLER_SOCKET'),
      )
    }
    if (Date.now() < retryAt && lastError !== null) return Promise.reject(lastError)
    dialStartedAt = Date.now()
    dialing = dial(path)
      .then((l) => {
        // Closed while the dial was in flight: this connection is nobody's.
        if (closed) {
          l.socket.destroy()
          live = null
          throw new ControllerError('closed', 'this client was closed')
        }
        failures = 0
        lastError = null
        connectedAt = Date.now()
        down = null
        // After the return below has settled `live`, so a call the hook
        // makes rides this connection rather than dialling another.
        if (opts.onConnect !== undefined) queueMicrotask(() => opts.onConnect?.(self))
        return l
      })
      .catch((e: unknown) => {
        const err = e instanceof ControllerError ? e : new ControllerError('unreachable', String(e))
        failures += 1
        lastError = err
        down = { since: down?.since ?? Date.now(), error: err }
        retryAt = Date.now() + Math.min(backoffMs * 2 ** (failures - 1), backoffMaxMs)
        throw err
      })
      .finally(() => {
        dialing = null
      })
    return dialing
  }

  const call = async <T>(
    m: string,
    decodeAnswer: (v: unknown) => T,
    p?: Record<string, unknown>,
    waitMs?: number,
  ): Promise<T> => {
    const l = await connection()
    return decodeAnswer(await send(l.socket, m, p, waitMs))
  }

  const self: ControllerClient = {
    systemInfo: () => call('system.info', systemInfo),
    claudeStatus: () => call('claude.status', claudeStatus),
    claudeRestart: () => call('claude.restart', queued),
    claudeRoster: () => call('claude.roster', claudeRosterGet),
    claudeSession: (action, id) => call('claude.session', sessionQueued, { action, id }),
    telemetryGet: () => call('telemetry.get', telemetryGet),
    nodesList: () => call('nodes.list', nodesList),
    nodesGet: (id) => call('nodes.get', nodeDetail, { id }),
    nodesTelemetry: (id) => call('nodes.telemetry', nodeTelemetryAnswer, { id }),
    nodesProviders: (id) => call('nodes.providers', nodeProvidersAnswer, { id }),
    nodesProviderModel: (id, verb) =>
      call('nodes.provider_model', providerModelSent, { id, ...verb }, relayedMs),
    nodesClaude: (id) => call('nodes.claude', nodeClaudeAnswer, { id }),
    nodesClaudeRoster: (id) => call('nodes.claude_roster', nodeClaudeRosterAnswer, { id }),
    nodesClaudeSession: (id, action, session) =>
      call('nodes.claude_session', claudeSessionSent, { id, action, session }, relayedMs),
    nodesSetDesired: (nodes) => call('nodes.set_desired', setDesiredOk, { nodes }),
    nodesCommand: (id, command) => call('nodes.command', commandOk, { id, command }, relayedMs),
    controllerRotate: (p) => call('controller.rotate', controllerRotated, p),
    rootRun: (verb, selectors, waitMs, payload) =>
      call(
        'root.run',
        rootRunOk,
        { verb, selectors: selectors ?? {}, ...(payload === undefined ? {} : { payload }) },
        waitMs,
      ),
    santreeStatus: () => call('santree.status', santreeStatus),
    hello: () => (live !== null && !live.socket.destroyed ? live.hello : null),
    link: () => {
      const at = (ms: number) => new Date(ms).toISOString()
      if (opts.path === undefined) return { state: 'not_configured' }
      if (live !== null && !live.socket.destroyed)
        return { state: 'connected', since: at(connectedAt) }
      if (down !== null) return { state: 'down', since: at(down.since), error: down.error.message }
      if (dialing !== null) return { state: 'connecting', since: at(dialStartedAt) }
      return { state: 'idle' }
    },
    close: () => {
      closed = true
      live?.socket.destroy()
      live = null
    },
  }
  return self
}

/** A dial that failed, in words a page can print after "Controller not reachable: ". */
function unreachable(path: string, e: NodeJS.ErrnoException): ControllerError {
  const why =
    e.code === 'ENOENT'
      ? `no socket at ${path}; is daedalus-controller running?`
      : e.code === 'ECONNREFUSED'
        ? `nothing answers on ${path}`
        : e.code === 'EACCES'
          ? `${path} refuses this container's user`
          : `${path}: ${e.message}`
  return new ControllerError('unreachable', why)
}

/** `daedalus/<version>`, from the package.json this process runs out of. */
function clientName(): string {
  try {
    const path = env.get('ENGINE_PACKAGE_JSON') ?? join(process.cwd(), 'package.json')
    const v = (JSON.parse(readFileSync(path, 'utf8')) as { version?: unknown }).version
    return typeof v === 'string' && v !== '' ? `daedalus/${v}` : 'daedalus'
  } catch {
    return 'daedalus'
  }
}

// ── the process's one client ────────────────────────────────────────────────

const SLOT = Symbol.for('daedalus.controller')
type Slot = { client: ControllerClient | null; path: string | undefined; exitHooked: boolean }
const holder = globalThis as unknown as Record<symbol, Slot | undefined>

// A re-evaluated copy of this module (a Vite reload) closes the client the
// previous copy made — for good, so a stale closure still holding it cannot
// dial again — and the next `controller()` makes this copy's. A process
// never holds more than one connection.
{
  const prev = holder[SLOT]
  if (prev !== undefined) {
    prev.client?.close()
    prev.client = null
  }
}

/** This process's client for the socket CONTROLLER_SOCKET names. */
export function controller(): ControllerClient {
  const path = env.get('CONTROLLER_SOCKET')
  const slot = holder[SLOT] ?? { client: null, path, exitHooked: false }
  holder[SLOT] = slot
  if (slot.client === null || slot.path !== path) {
    slot.client?.close()
    slot.client = createControllerClient({
      path,
      client: clientName(),
      // Every (re)connection hands the controller the desired set again: it
      // keeps nothing across its own restart (./nodes.ts).
      onConnect: (c) => {
        void import('./nodes').then((m) => m.syncDesired({ controller: c }))
      },
      // A machine that logged out asks to be forgotten, its tunnel with it;
      // one whose user changed a setting from its menu bar asks for it
      // (core/nodes.ts `applyNodePolicyRequest`).
      onEvent: (e, p) => {
        const id = nodeLeftId(e, p)
        if (id !== null) {
          void Promise.all([import('../../core/nodes'), import('../../core/ctx')])
            .then(async ([m, c]) => m.forgetNode(await c.makeCtx(), id, { left: true }))
            .catch((err: unknown) => {
              console.warn(`controller: ${id} logged out but was not forgotten: ${String(err)}`)
            })
          return
        }
        const asked = nodePolicyRequest(e, p)
        if (asked !== null) {
          void Promise.all([import('../../core/nodes'), import('../../core/ctx')])
            .then(async ([m, c]) =>
              m.applyNodePolicyRequest(await c.makeCtx(), asked.id, asked.changes),
            )
            .catch((err: unknown) => {
              console.warn(
                `controller: ${asked.id}'s settings request was not applied: ${String(err)}`,
              )
            })
        }
      },
    })
    slot.path = path
  }
  if (!slot.exitHooked) {
    slot.exitHooked = true
    process.once('exit', () => holder[SLOT]?.client?.close())
  }
  return slot.client
}
