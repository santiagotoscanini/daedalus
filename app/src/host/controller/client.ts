import { readFileSync } from 'node:fs'
import { createConnection, type Socket } from 'node:net'
import { join } from 'node:path'
import { decode } from '../../lib/contract/decode'
import { env } from '../env'
import type { ApiEvent, HelloOk, Methods } from './generated'
import { ACK_TIMEOUT_MS, API_VERSION, MAX_LINE, ROOT_DETACH_WAIT_MS } from './generated/constants'
import { ANSWERS, ControllerError, eventOf, parseLine, requestLine } from './wire'

// The app's one door to the controller: the agent on the box, over the unix
// socket nix mounts into this container (CONTROLLER_SOCKET). The protocol is
// agent/README.md "Controller mode" and agent/src/controller/api/: newline-delimited
// JSON, `hello` first, answers matched by `id` because the agent runs
// requests concurrently. Every method is `call(method, params)`, typed by
// the generated `Methods` map and decoded by its answer's decoder (./wire.ts
// `ANSWERS`): an answer that does not decode fails the call as `protocol`.
//
// ONE connection per process. The agent serves at most 16 at once and turns
// the seventeenth away, so a connection per request — or one leaked per Vite
// reload — would lock the app out of its own box. The live client is kept on
// globalThis, and a re-evaluated copy of this module (HMR) closes the
// previous copy's before it takes the slot. It connects on the first call,
// not at import; a connection that closes is re-dialled by the next call —
// or at once, when the process wants the controller's events — and a dial
// that fails holds off the next for a backoff that doubles to ten seconds,
// answering `unreachable` meanwhile rather than hammering a controller that
// is down.
//
// No retry ladder: the socket is local, so a request either answers within
// the timeout or the controller is wedged, and asking again would only queue
// behind the first.

/** One call, and the hello, answer within this long or fail `timeout`. */
const TIMEOUT_MS = 3_000
/**
 * The verbs the controller relays to a machine and waits for it to
 * acknowledge: those wait the controller's `ACK_TIMEOUT_MS` plus the
 * client's own timeout, so the controller's answer — the ack, or its own
 * `timeout` — is what the caller hears.
 */
const RELAYED: ReadonlySet<keyof Methods> = new Set([
  'nodes.command',
  'nodes.claude_session',
  'nodes.provider_model',
])
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
  | {
      state: 'connected'
      since: string /** The controller's agent, as its hello said. */
      version: string
    }
  | { state: 'down'; since: string; error: string }

/** The methods a caller asks: `hello` and `events.subscribe` belong to the connection. */
export type CallMethod = Exclude<keyof Methods, 'hello' | 'events.subscribe'>

/** A call's own wait, for a verb that runs longer than a request (`root.run`). */
export type CallOptions = { waitMs?: number }

/** A method's arguments: none for one that takes no parameters. */
export type CallArgs<M extends keyof Methods> = Methods[M][0] extends null
  ? [p?: null, opts?: CallOptions]
  : [p: Methods[M][0], opts?: CallOptions]

export type ControllerClient = {
  /** One method: its generated parameters in, its generated answer out. */
  call: <M extends CallMethod>(m: M, ...args: CallArgs<M>) => Promise<Methods[M][1]>
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
   * (`events.subscribe`) and hands each here, decoded.
   */
  onEvent?: (event: ApiEvent) => void
}

type Pending = {
  resolve: (v: unknown) => void
  reject: (e: ControllerError) => void
  timer: ReturnType<typeof setTimeout>
}

/** An open, hello'd connection. */
type Live = { socket: Socket; hello: HelloOk }

/** How long `m` may take to answer, before the caller's own wait. */
function waitFor(m: keyof Methods, p: unknown, timeoutMs: number): number {
  if (RELAYED.has(m)) return ACK_TIMEOUT_MS + timeoutMs
  // A detached run answers once its unit has started: the controller waits
  // up to ROOT_DETACH_WAIT_MS for that.
  if (m === 'root.run' && (p as { detach?: boolean } | null)?.detach === true) {
    return ROOT_DETACH_WAIT_MS + 5_000
  }
  return timeoutMs
}

/**
 * A client over one socket path. The process's own is `controller()`; the
 * tests make theirs against a fake server.
 */
export function createControllerClient(opts: Options): ControllerClient {
  const timeoutMs = opts.timeoutMs ?? TIMEOUT_MS
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
  let redial: ReturnType<typeof setTimeout> | null = null
  const pending = new Map<number, Pending>()

  const failAll = (e: ControllerError) => {
    for (const [id, p] of pending) {
      clearTimeout(p.timer)
      pending.delete(id)
      p.reject(e)
    }
  }

  /** Write one request on `socket` and wait for its answer, undecoded. */
  const send = <M extends keyof Methods>(
    socket: Socket,
    m: M,
    p: Methods[M][0],
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
          keepDialled()
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
          // An event this app cannot read, or a handler that fails, is its
          // own business; it never costs the connection.
          try {
            opts.onEvent?.(eventOf(msg.e, msg.p))
          } catch (e) {
            console.warn(`controller: the ${msg.e} event: ${String(e)}`)
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
          .then(async (ok) => {
            const hello = decode(ANSWERS.hello, ok)
            // The events belong to the connection, so each one subscribes, and
            // one that cannot is a connection that failed: it would hold, and
            // never hand over the event a machine waits on.
            if (opts.onEvent !== undefined) {
              decode(ANSWERS['events.subscribe'], await send(socket, 'events.subscribe', null))
            }
            if (settled) return
            settled = true
            const l = { socket, hello }
            live = l
            resolve(l)
          })
          .catch((e: unknown) => {
            drop(e instanceof ControllerError ? e : new ControllerError('protocol', String(e)))
          })
      })
    })

  /**
   * With events wanted, a connection that ends is dialled again — at once,
   * then paced by the backoff — and subscribes again, so an event a machine
   * waits on is not left for the next call to come along.
   */
  const keepDialled = () => {
    if (opts.onEvent === undefined || closed || redial !== null) return
    redial = setTimeout(
      () => {
        redial = null
        // A failure schedules the next attempt itself (the catch below).
        connection().catch(() => undefined)
      },
      Math.max(0, retryAt - Date.now()),
    )
    redial.unref()
  }

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
        keepDialled()
        throw err
      })
      .finally(() => {
        dialing = null
      })
    return dialing
  }

  const call = async <M extends CallMethod>(
    m: M,
    ...[p, o]: CallArgs<M>
  ): Promise<Methods[M][1]> => {
    const params = (p ?? null) as Methods[M][0]
    const l = await connection()
    const answer = await send(l.socket, m, params, o?.waitMs ?? waitFor(m, params, timeoutMs))
    try {
      return decode(ANSWERS[m] as (v: unknown, path: string) => Methods[M][1], answer)
    } catch (e) {
      throw new ControllerError('protocol', `the controller's answer to ${m}: ${String(e)}`)
    }
  }

  const self: ControllerClient = {
    call,
    hello: () => (live !== null && !live.socket.destroyed ? live.hello : null),
    link: () => {
      const at = (ms: number) => new Date(ms).toISOString()
      if (opts.path === undefined) return { state: 'not_configured' }
      if (live !== null && !live.socket.destroyed)
        return { state: 'connected', since: at(connectedAt), version: live.hello.version }
      if (down !== null) return { state: 'down', since: at(down.since), error: down.error.message }
      if (dialing !== null) return { state: 'connecting', since: at(dialStartedAt) }
      return { state: 'idle' }
    },
    close: () => {
      closed = true
      if (redial !== null) clearTimeout(redial)
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
      onEvent: (event) => {
        const id = event.p.id
        void Promise.all([import('../../core/nodes'), import('../../core/ctx')])
          .then(async ([m, c]) =>
            event.e === 'nodes.left'
              ? m.forgetNode(await c.makeCtx(), id, { left: true })
              : m.applyNodePolicyRequest(await c.makeCtx(), id, event.p.changes),
          )
          .catch((err: unknown) => {
            console.warn(`controller: ${event.e} for ${id} was not acted on: ${String(err)}`)
          })
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
