import { roster } from '../../lib/agent/roster'
import { report, statusDocument, summary, telemetry } from '../../lib/agent/status'
import {
  absent,
  arrayOf,
  bool,
  type Decoder,
  decode,
  int,
  nint,
  nnum,
  nstr,
  nullable,
  obj,
  oneOf,
  reads,
  recordOf,
  str,
} from '../../lib/contract/decode'
import type {
  ApiError,
  ApiEvent,
  Capability,
  ControllerInfo,
  ErrorCode,
  Hello,
  Methods,
  Mode,
  NodeSummary,
  ProviderReport,
  RootRunSummary,
  TelemetryLevel,
} from './generated'

// The controller's local API as this app reads it: agent/src/api/wire.rs is
// the writer and the contract. Its types are GENERATED from the Rust
// (agent/src/ts.rs → ./generated/: each type, the `Methods` map, the
// constants), and every decoder here is held to them both ways (`reads`), so
// a caller gets the generated type itself. wire.test.ts decodes the agent's
// own fixtures (./generated/fixtures/). The box's app and its controller
// ship together: a field the agent no longer writes, or one this app cannot
// read, fails the call as `protocol` rather than reading as a fallback, and
// an agent of another version is said so (`hello`, the shell's banner).
//
// Pure: no socket here. host/controller/client.ts is the connection.

/**
 * Why a call failed: one of the agent's codes, or this side's own —
 * `not_configured` (no CONTROLLER_SOCKET), `unreachable` (no socket, or
 * nothing answering on it), `timeout`, `closed` (the connection ended with
 * the call unanswered) and `protocol` (a line or an answer that is not the
 * wire's).
 */
export type ControllerCode =
  | ErrorCode
  | 'not_configured'
  | 'unreachable'
  | 'timeout'
  | 'closed'
  | 'protocol'

export class ControllerError extends Error {
  readonly code: ControllerCode
  /** The API version the agent speaks; only on a `version` error. */
  readonly supported: number | null
  constructor(code: ControllerCode, message: string, supported: number | null = null) {
    super(message)
    this.name = 'ControllerError'
    this.code = code
    this.supported = supported
  }
}

const errorCode = oneOf<ErrorCode>({
  bad_request: true,
  version: true,
  unknown_method: true,
  unsupported: true,
  unavailable: true,
  busy: true,
  too_large: true,
  forbidden: true,
  revoked: true,
  internal: true,
  not_found: true,
  santree_off: true,
  host_key_changed: true,
  unknown: true,
})

const apiError = reads<ApiError>()(obj({ code: errorCode, msg: str, supported: absent(int) }))

/** An `err` body as a ControllerError; one this app cannot read is `protocol`. */
export function errorOf(body: unknown): ControllerError {
  try {
    const e = decode(apiError, body)
    return new ControllerError(e.code, e.msg, e.supported ?? null)
  } catch (e) {
    return new ControllerError('protocol', `an error this app cannot read: ${String(e)}`)
  }
}

// ── one line ────────────────────────────────────────────────────────────────

/** A line from the agent: an answer to `id`, or an event. */
export type Incoming =
  | { kind: 'ok'; id: number; ok: unknown }
  | { kind: 'err'; id: number | null; error: ControllerError }
  | { kind: 'event'; e: string; p: unknown }

/** One line as the agent wrote it; throws a `protocol` ControllerError on anything else. */
export function parseLine(line: string): Incoming {
  let v: unknown
  try {
    v = JSON.parse(line)
  } catch {
    throw new ControllerError('protocol', 'the controller wrote a line that is not JSON')
  }
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    throw new ControllerError('protocol', 'the controller wrote a line that is not an object')
  }
  const o = v as Record<string, unknown>
  if (typeof o.e === 'string') return { kind: 'event', e: o.e, p: o.p ?? null }
  const id = typeof o.id === 'number' && Number.isSafeInteger(o.id) ? o.id : null
  if (o.err !== undefined) return { kind: 'err', id, error: errorOf(o.err) }
  if (id !== null && Object.hasOwn(o, 'ok')) return { kind: 'ok', id, ok: o.ok }
  throw new ControllerError(
    'protocol',
    'the controller wrote a line that is neither an answer nor an event',
  )
}

/** A request line, newline included: a method that takes no parameters carries no `p`. */
export function requestLine<M extends keyof Methods>(id: number, m: M, p: Methods[M][0]): string {
  return `${JSON.stringify(p === null ? { id, m } : { id, m, p })}\n`
}

// ── the answers ─────────────────────────────────────────────────────────────

const mode = oneOf<Mode>({ node: true, controller: true })
const level = oneOf<TelemetryLevel>({ full: true, minimal: true, off: true })
const nodeState = oneOf({ pending: true, approved: true, revoked: true, unknown: true })
const capability = oneOf<Capability>({
  'claude.remote_control': true,
  'claude.update': true,
  'claude.sessions': true,
  'telemetry.full': true,
  'telemetry.minimal': true,
  'providers.residency': true,
  nodes: true,
  root: true,
  santree: true,
  controller: true,
  unknown: true,
})
const outcome = nullable(oneOf({ done: true, refused: true, failed: true }))
const ids = arrayOf(str)

const controllerInfo = reads<ControllerInfo>()(
  obj({
    public_key: str,
    fingerprint: str,
    listen: nstr,
    advertise: arrayOf(str),
    rotation: nullable(
      obj({
        from_public_key: str,
        from_fingerprint: str,
        started_at: str,
        retires_at: str,
        old_key_connections: int,
      }),
    ),
  }),
)

const nodeSummaryShape = {
  id: str,
  fingerprint: str,
  state: nodeState,
  connected: bool,
  since: nstr,
  last_seen: nstr,
  hostname: nstr,
  os: nstr,
  arch: nstr,
  agent_version: nstr,
  lan_ip: nstr,
  mac: nstr,
  claude: nullable(summary),
}

const nodeSummary = reads<NodeSummary>()(obj(nodeSummaryShape))

const hello = reads<Hello>()(
  obj({
    proto: int,
    node_id: str,
    agent_version: str,
    os: str,
    arch: str,
    hostname: str,
    mac: nstr,
    lan_ip: nstr,
    facts: obj({ os_name: str, os_version: str, cpu: str, memory_bytes: nint }),
    capabilities: arrayOf(capability),
    telemetry: level,
  }),
)

const providerReport = reads<ProviderReport>()(
  obj({
    kind: oneOf({ lemonade: true, unknown: true }),
    port: int,
    version: nstr,
    running: bool,
    healthy: bool,
    loaded: arrayOf(obj({ id: str, device: nstr, max_context: nint, pinned: bool })),
    models: arrayOf(
      obj({ id: str, labels: arrayOf(str), downloaded: bool, size_gb: nnum, recipe: nstr }),
    ),
    downloads: arrayOf(obj({ model: str, percent: nnum, status: str })),
    backends: arrayOf(obj({ recipe: str, backend: str, version: nstr, url: nstr })),
    figures: arrayOf(
      obj({
        model: str,
        requests: nnum,
        input_tokens: nnum,
        output_tokens: nnum,
        tps: nnum,
        ttft_ms: nnum,
        device: nstr,
        checkpoint: nstr,
      }),
    ),
    read_at: str,
    error: nstr,
    actions: arrayOf(obj({ request: str, model: str, ok: bool, message: str, at: str })),
  }),
)

const rootRunSummary = reads<RootRunSummary>()(
  obj({
    run: str,
    verb: str,
    started_at: str,
    finished_at: nstr,
    started: bool,
    outcome,
    detail: str,
  }),
)

const delivered = obj({ delivered: bool, request: str })

/**
 * Every method's answer, decoded to its generated type: a record over the
 * generated `Methods`, so a method the agent adds or changes is a compile
 * error here until its answer is read.
 */
export const ANSWERS: { [M in keyof Methods]: Decoder<Methods[M][1]> } = {
  hello: reads<Methods['hello'][1]>()(
    obj({ api: int, version: str, mode, hostname: str, capabilities: arrayOf(capability) }),
  ),
  'events.subscribe': reads<Methods['events.subscribe'][1]>()(obj({})),
  'system.info': reads<Methods['system.info'][1]>()(
    obj({
      api: int,
      version: str,
      mode,
      hostname: str,
      os: obj({ os: str, name: str, version: str, arch: str, cpu: str, memory_bytes: nint }),
      uptime_secs: int,
      os_uptime_secs: nint,
      booted_at: nstr,
      role: obj({
        mode,
        link: bool,
        self_update: bool,
        keep_awake: bool,
        installer: bool,
        session: bool,
        session_in_service: bool,
        claude_update: bool,
        tray: bool,
        status_on_lan: bool,
        api_socket: bool,
        node_listener: bool,
      }),
      telemetry: level,
      capabilities: arrayOf(capability),
      controller: nullable(controllerInfo),
    }),
  ),
  'claude.status': reads<Methods['claude.status'][1]>()(
    obj({ reporting: bool, wanted: bool, report: nullable(report) }),
  ),
  'claude.restart': reads<Methods['claude.restart'][1]>()(obj({ queued: bool })),
  'claude.roster': reads<Methods['claude.roster'][1]>()(
    obj({ reporting: bool, roster: nullable(roster) }),
  ),
  'claude.session': reads<Methods['claude.session'][1]>()(obj({ queued: bool, request: str })),
  'telemetry.get': reads<Methods['telemetry.get'][1]>()(
    obj({ level, telemetry: nullable(telemetry) }),
  ),
  'actions.get': reads<Methods['actions.get'][1]>()(
    nullable(
      obj({
        state: oneOf({ running: true, done: true, refused: true, failed: true }),
        detail: str,
      }),
    ),
  ),
  'nodes.list': reads<Methods['nodes.list'][1]>()(obj({ nodes: arrayOf(nodeSummary) })),
  'nodes.get': reads<Methods['nodes.get'][1]>()(
    obj({
      ...nodeSummaryShape,
      public_key: str,
      hello: nullable(hello),
      status: nullable(statusDocument),
      status_at: nstr,
      telemetry: nullable(telemetry),
      telemetry_at: nstr,
      providers: nullable(arrayOf(providerReport)),
      providers_at: nstr,
    }),
  ),
  'nodes.telemetry': reads<Methods['nodes.telemetry'][1]>()(
    obj({ id: str, telemetry: nullable(telemetry), received_at: nstr }),
  ),
  'nodes.providers': reads<Methods['nodes.providers'][1]>()(
    obj({
      id: str,
      connected: bool,
      providers: nullable(arrayOf(providerReport)),
      received_at: nstr,
    }),
  ),
  'nodes.claude': reads<Methods['nodes.claude'][1]>()(
    obj({ id: str, report: nullable(report), received_at: nstr }),
  ),
  'nodes.claude_roster': reads<Methods['nodes.claude_roster'][1]>()(
    obj({ id: str, roster: nullable(roster), received_at: nstr }),
  ),
  'nodes.claude_session': reads<Methods['nodes.claude_session'][1]>()(delivered),
  'nodes.provider_model': reads<Methods['nodes.provider_model'][1]>()(delivered),
  'nodes.set_desired': reads<Methods['nodes.set_desired'][1]>()(
    obj({ nodes: int, approved: ids, revoked: ids, pending: ids, policy: ids }),
  ),
  'nodes.command': reads<Methods['nodes.command'][1]>()(obj({ delivered: bool, queued: bool })),
  'controller.rotate': controllerInfo,
  'root.run': reads<Methods['root.run'][1]>()(
    obj({
      run: str,
      verb: str,
      outcome,
      detail: str,
      verbs: absent(
        arrayOf(
          obj({
            verb: str,
            unit: str,
            description: str,
            selectors: recordOf(arrayOf(str)),
            patterns: recordOf(str),
            payload_max: nint,
            active_state: nstr,
            result: nstr,
          }),
        ),
      ),
    }),
  ),
  'root.follow': reads<Methods['root.follow'][1]>()(
    obj({
      run: rootRunSummary,
      lines: arrayOf(obj({ seq: int, line: str })),
      next: int,
      more: bool,
      dropped: bool,
    }),
  ),
  'root.runs': reads<Methods['root.runs'][1]>()(obj({ runs: arrayOf(rootRunSummary) })),
  'santree.status': reads<Methods['santree.status'][1]>()(
    obj({
      state: oneOf({ running: true, stale: true, stopped: true, missing: true }),
      version: nstr,
      restart_pending: bool,
      live_ptys: int,
      connections: arrayOf(obj({ node: str, name: nstr, count: int })),
      error: nstr,
    }),
  ),
}

// ── events ──────────────────────────────────────────────────────────────────

const nodeId = (v: unknown, p: string): string => {
  const id = str(v, p)
  if (!/^[0-9a-f]{16}$/.test(id)) throw new Error(`${p}: not a node id`)
  return id
}

const EVENTS: { [E in ApiEvent['e']]: Decoder<Extract<ApiEvent, { e: E }>['p']> } = {
  'nodes.left': obj({ id: nodeId }),
  'nodes.policy_request': obj({
    id: nodeId,
    changes: obj({
      awake_hold: absent(bool),
      claude_remote_control: absent(bool),
      santree: absent(bool),
    }),
  }),
}

/** An event as the agent pushed it, decoded; a protocol error for one this app does not know. */
export function eventOf(e: string, p: unknown): ApiEvent {
  if (!Object.hasOwn(EVENTS, e)) {
    throw new ControllerError(
      'protocol',
      `the controller pushed an event this app does not know: ${e}`,
    )
  }
  const name = e as ApiEvent['e']
  try {
    return { e: name, p: decode(EVENTS[name] as Decoder<unknown>, p) } as ApiEvent
  } catch (err) {
    throw new ControllerError('protocol', `the ${e} event: ${String(err)}`)
  }
}
