import type { WirePolicy } from '../../lib/agent/policy'
import {
  type AgentStatus,
  agentStatus,
  type NodeClaude,
  type NodeClaudeSummary,
  type NodeTelemetry,
  nodeClaudeReport,
  nodeClaudeSummary,
  nodeTelemetry,
} from '../../lib/agent/status'
import { arrayOf, bool, decode, int, nullable, obj, optional, str } from '../../lib/contract/decode'

// The controller's local API as this app reads it: agent/src/api/wire.rs is
// the writer and the contract, and wire.test.ts decodes the golden lines its
// tests pin. Tolerant like every reader here — a field the agent adds is
// ignored, one it drops decodes to its fallback — because the app deploys on
// save and the controller moves with a lock bump, so the two meet at
// different versions as a matter of course. The API version is what says
// they cannot talk at all (`API_VERSION`, the `version` error).
//
// Pure: no socket here. host/controller/client.ts is the connection.

/** The API version this app speaks (wire.rs `API_VERSION`). */
export const API_VERSION = 1
/** The longest line either side writes (api/mod.rs `MAX_LINE`), in bytes. */
export const MAX_LINE = 1 << 20

/** Every code the agent answers an error with (wire.rs `code::`). */
export const AGENT_CODES = [
  'bad_request',
  'version',
  'unknown_method',
  'unsupported',
  'unavailable',
  'busy',
  'too_large',
  'forbidden',
  'internal',
  'not_found',
] as const
export type AgentCode = (typeof AGENT_CODES)[number]

/**
 * Why a call failed: one of the agent's codes, or this side's own —
 * `not_configured` (no CONTROLLER_SOCKET), `unreachable` (no socket, or
 * nothing answering on it), `timeout`, `closed` (the connection ended with
 * the call unanswered) and `protocol` (a line that is not the wire's).
 */
export type ControllerCode =
  | AgentCode
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

const nstr = optional(nullable(str), null)
const nint = optional(nullable(int), null)

// ── one line ────────────────────────────────────────────────────────────────

/** A line from the agent: an answer to `id`, or an event. */
export type Incoming =
  | { kind: 'ok'; id: number; ok: unknown }
  | { kind: 'err'; id: number | null; error: ControllerError }
  | { kind: 'event'; e: string; p: unknown }

const errShape = obj({ code: str, msg: optional(str, ''), supported: nint })

/** An `err` body as a ControllerError; a code this app does not know is `protocol`. */
export function errorOf(body: unknown): ControllerError {
  const e = decode(errShape, body)
  const known = (AGENT_CODES as readonly string[]).includes(e.code)
  return known
    ? new ControllerError(e.code as AgentCode, e.msg, e.supported)
    : new ControllerError('protocol', `${e.code}: ${e.msg}`)
}

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

/** A request line, newline included. */
export function requestLine(id: number, m: string, p?: Record<string, unknown>): string {
  return `${JSON.stringify(p === undefined ? { id, m } : { id, m, p })}\n`
}

// ── the answers ─────────────────────────────────────────────────────────────

/** `node` or `controller` (config.rs `Mode`); a newer agent's other mode reads as itself. */
export type AgentMode = 'node' | 'controller' | (string & {})
/** `full`, `minimal` or `off` (config.rs `TelemetryLevel`). */
export type TelemetryLevel = 'full' | 'minimal' | 'off' | (string & {})

export type HelloOk = {
  api: number
  version: string
  mode: AgentMode
  hostname: string
  capabilities: string[]
}

const helloShape = obj({
  api: int,
  version: str,
  mode: str,
  hostname: optional(str, ''),
  capabilities: optional(arrayOf(str), []),
})

export const helloOk = (v: unknown): HelloOk => decode(helloShape, v)

/** Which parts of the agent run (role.rs `Role`). */
export type AgentRole = {
  mode: AgentMode
  link: boolean
  selfUpdate: boolean
  keepAwake: boolean
  installer: boolean
  session: boolean
  sessionInService: boolean
  claudeUpdate: boolean
  tray: boolean
  statusOnLan: boolean
  apiSocket: boolean
  nodeListener: boolean
}

/**
 * The controller's own key and where machines reach it (wire.rs
 * `ControllerInfo`): what an install command pins and dials. `advertise` is
 * the `host:port`s config.toml names, first one first.
 */
export type ControllerInfo = {
  /** 64 hex characters. */
  publicKey: string
  /** The key's SHA-256 in four-character groups: what a machine's tray shows. */
  fingerprint: string
  listen: string | null
  advertise: string[]
}

export type SystemInfo = {
  api: number
  version: string
  mode: AgentMode
  hostname: string
  os: {
    os: string
    name: string
    version: string
    arch: string
    cpu: string
    memoryBytes: number | null
  }
  /** The agent's own uptime. */
  uptimeSecs: number
  osUptimeSecs: number | null
  bootedAt: string | null
  role: AgentRole
  telemetry: TelemetryLevel
  capabilities: string[]
  /** Only on the controller. */
  controller: ControllerInfo | null
}

const flag = optional(bool, false)

const systemInfoShape = obj({
  api: int,
  version: str,
  mode: str,
  hostname: optional(str, ''),
  os: obj({
    os: optional(str, ''),
    name: optional(str, ''),
    version: optional(str, ''),
    arch: optional(str, ''),
    cpu: optional(str, ''),
    memory_bytes: nint,
  }),
  uptime_secs: optional(int, 0),
  os_uptime_secs: nint,
  booted_at: nstr,
  role: obj({
    mode: optional(str, ''),
    link: flag,
    self_update: flag,
    keep_awake: flag,
    installer: flag,
    session: flag,
    session_in_service: flag,
    claude_update: flag,
    tray: flag,
    status_on_lan: flag,
    api_socket: flag,
    node_listener: flag,
  }),
  telemetry: optional(str, 'off'),
  capabilities: optional(arrayOf(str), []),
  controller: optional(
    nullable(
      obj({
        public_key: str,
        fingerprint: str,
        listen: nstr,
        advertise: optional(arrayOf(str), []),
      }),
    ),
    null,
  ),
})

export function systemInfo(v: unknown): SystemInfo {
  const s = decode(systemInfoShape, v)
  const r = s.role
  return {
    api: s.api,
    version: s.version,
    mode: s.mode,
    hostname: s.hostname,
    os: {
      os: s.os.os,
      name: s.os.name,
      version: s.os.version,
      arch: s.os.arch,
      cpu: s.os.cpu,
      memoryBytes: s.os.memory_bytes,
    },
    uptimeSecs: s.uptime_secs,
    osUptimeSecs: s.os_uptime_secs,
    bootedAt: s.booted_at,
    role: {
      mode: r.mode,
      link: r.link,
      selfUpdate: r.self_update,
      keepAwake: r.keep_awake,
      installer: r.installer,
      session: r.session,
      sessionInService: r.session_in_service,
      claudeUpdate: r.claude_update,
      tray: r.tray,
      statusOnLan: r.status_on_lan,
      apiSocket: r.api_socket,
      nodeListener: r.node_listener,
    },
    telemetry: s.telemetry,
    capabilities: s.capabilities,
    controller:
      s.controller === null
        ? null
        : {
            publicKey: s.controller.public_key,
            fingerprint: s.controller.fingerprint,
            listen: s.controller.listen,
            advertise: s.controller.advertise,
          },
  }
}

/**
 * `claude.status`: the session's last report, the same document a node's
 * `/claude` answers (lib/agent/status.ts decodes both). `reporting` false
 * means no session reported lately, and `report` is null.
 */
export type ClaudeStatus = { reporting: boolean; wanted: boolean; report: NodeClaude | null }

const claudeStatusShape = obj({
  reporting: flag,
  wanted: flag,
  report: optional(
    nullable((v: unknown) => v),
    null,
  ),
})

export function claudeStatus(v: unknown): ClaudeStatus {
  const s = decode(claudeStatusShape, v)
  return {
    reporting: s.reporting,
    wanted: s.wanted,
    report: s.report === null ? null : nodeClaudeReport(s.report),
  }
}

/** `claude.restart`: the instruction is queued for the session. */
export type Queued = { queued: boolean }

export const queued = (v: unknown): Queued => decode(obj({ queued: flag }), v)

/**
 * `telemetry.get`: the level config.toml sets and the latest document at it
 * — null at `off` and before the first sample. The document is the one a
 * node's `/telemetry` answers (lib/agent/status.ts).
 */
export type TelemetryGet = { level: TelemetryLevel; telemetry: NodeTelemetry | null }

const telemetryGetShape = obj({
  level: optional(str, 'off'),
  telemetry: optional(
    nullable((v: unknown) => v),
    null,
  ),
})

export function telemetryGet(v: unknown): TelemetryGet {
  const t = decode(telemetryGetShape, v)
  return { level: t.level, telemetry: t.telemetry === null ? null : nodeTelemetry(t.telemetry) }
}

// ── the machines (`nodes.*`) ────────────────────────────────────────────────

/**
 * Where a machine stands at the controller (link/wire.rs `NodeState`):
 * `pending` (connected, not decided), `approved`, `revoked`, or `unknown`
 * (seen, not decided, gone).
 */
export type LinkState = 'pending' | 'approved' | 'revoked' | 'unknown' | (string & {})

/**
 * A machine as `nodes.list` lists it. The hello's fields are null for a key
 * the app named that has not connected since the controller started — the
 * controller keeps nothing across a restart.
 */
export type ControllerNode = {
  id: string
  fingerprint: string
  state: LinkState
  connected: boolean
  /** When the current connection opened; null while disconnected. */
  since: string | null
  /** The last line heard from it. */
  lastSeen: string | null
  hostname: string | null
  os: string | null
  arch: string | null
  agentVersion: string | null
  lanIp: string | null
  mac: string | null
  claude: NodeClaudeSummary | null
}

const anyJson = optional(
  nullable((v: unknown) => v),
  null,
)

const nodeShape = {
  id: str,
  fingerprint: optional(str, ''),
  state: optional(str, 'unknown'),
  connected: flag,
  since: nstr,
  last_seen: nstr,
  hostname: nstr,
  os: nstr,
  arch: nstr,
  agent_version: nstr,
  lan_ip: nstr,
  mac: nstr,
  claude: anyJson,
}

const nodeWire = obj(nodeShape)

function nodeOf(n: ReturnType<typeof nodeWire>): ControllerNode {
  return {
    id: n.id,
    fingerprint: n.fingerprint,
    state: n.state,
    connected: n.connected,
    since: n.since,
    lastSeen: n.last_seen,
    hostname: n.hostname,
    os: n.os,
    arch: n.arch,
    agentVersion: n.agent_version,
    lanIp: n.lan_ip,
    mac: n.mac,
    claude: nodeClaudeSummary(n.claude),
  }
}

export function nodesList(v: unknown): ControllerNode[] {
  return decode(obj({ nodes: optional(arrayOf(nodeWire), []) }), v).nodes.map(nodeOf)
}

/** The machine's `hello` over the link (link/wire.rs `Hello`), as far as the app reads it. */
export type LinkHello = {
  agentVersion: string
  os: string
  arch: string
  hostname: string
  mac: string | null
  lanIp: string | null
  facts: { osName: string; osVersion: string; cpu: string; memoryBytes: number | null }
  capabilities: string[]
  telemetry: TelemetryLevel
}

const linkHelloShape = obj({
  agent_version: optional(str, ''),
  os: optional(str, ''),
  arch: optional(str, ''),
  hostname: optional(str, ''),
  mac: nstr,
  lan_ip: nstr,
  facts: optional(
    obj({
      os_name: optional(str, ''),
      os_version: optional(str, ''),
      cpu: optional(str, ''),
      memory_bytes: nint,
    }),
    { os_name: '', os_version: '', cpu: '', memory_bytes: null },
  ),
  capabilities: optional(arrayOf(str), []),
  telemetry: optional(str, 'off'),
})

/**
 * `nodes.get`: the summary, the key, the whole hello, the status document
 * (the machine's status page without its telemetry), the telemetry as the
 * open page shows it, and when each arrived.
 */
export type ControllerNodeDetail = ControllerNode & {
  /** 64 hex characters: the key the app approves. */
  publicKey: string
  hello: LinkHello | null
  status: AgentStatus | null
  statusAt: string | null
  telemetry: NodeTelemetry | null
  telemetryAt: string | null
}

/**
 * The status document, or null for one that is not (a machine's agent wrote
 * something this app cannot read): the page then says it has no status
 * rather than failing the whole machine.
 */
function statusOf(v: unknown): AgentStatus | null {
  if (v === null) return null
  try {
    return agentStatus(v)
  } catch {
    return null
  }
}

export function nodeDetail(v: unknown): ControllerNodeDetail {
  const d = decode(
    obj({
      ...nodeShape,
      public_key: str,
      hello: optional(nullable(linkHelloShape), null),
      status: anyJson,
      status_at: nstr,
      telemetry: anyJson,
      telemetry_at: nstr,
    }),
    v,
  )
  const h = d.hello
  return {
    ...nodeOf(d),
    publicKey: d.public_key,
    hello:
      h === null
        ? null
        : {
            agentVersion: h.agent_version,
            os: h.os,
            arch: h.arch,
            hostname: h.hostname,
            mac: h.mac,
            lanIp: h.lan_ip,
            facts: {
              osName: h.facts.os_name,
              osVersion: h.facts.os_version,
              cpu: h.facts.cpu,
              memoryBytes: h.facts.memory_bytes,
            },
            capabilities: h.capabilities,
            telemetry: h.telemetry,
          },
    status: statusOf(d.status),
    statusAt: d.status_at,
    telemetry: nodeTelemetry(d.telemetry),
    telemetryAt: d.telemetry_at,
  }
}

/** `nodes.telemetry`: the full document at the machine's level, and when it arrived. */
export type NodeTelemetryAnswer = { telemetry: NodeTelemetry | null; receivedAt: string | null }

export function nodeTelemetryAnswer(v: unknown): NodeTelemetryAnswer {
  const t = decode(obj({ telemetry: anyJson, received_at: nstr }), v)
  return { telemetry: nodeTelemetry(t.telemetry), receivedAt: t.received_at }
}

/** `nodes.claude`: the machine's full Claude report, and when it arrived. */
export type NodeClaudeAnswer = { report: NodeClaude | null; receivedAt: string | null }

export function nodeClaudeAnswer(v: unknown): NodeClaudeAnswer {
  const c = decode(obj({ report: anyJson, received_at: nstr }), v)
  return { report: nodeClaudeReport(c.report), receivedAt: c.received_at }
}

/**
 * One decided key, as `nodes.set_desired` takes it (wire.rs `DesiredNode`):
 * the controller refuses the WHOLE set if an `id` is not its key's, so the
 * builder (./nodes.ts) checks that before sending.
 */
export type DesiredNode = {
  id: string
  public_key: string
  state: 'approved' | 'revoked'
  /** The machine's policy (lib/agent/policy.ts); absent for a revoked key. */
  policy?: WirePolicy
}

/** `nodes.set_desired`'s answer: the ids whose open connection changed. */
export type SetDesiredOk = {
  nodes: number
  approved: string[]
  revoked: string[]
  pending: string[]
  policy: string[]
}

export function setDesiredOk(v: unknown): SetDesiredOk {
  const ids = optional(arrayOf(str), [])
  return decode(
    obj({ nodes: optional(int, 0), approved: ids, revoked: ids, pending: ids, policy: ids }),
    v,
  )
}

/** `nodes.command`'s answer: acknowledged now, or kept for the next connection. */
export type CommandOk = { delivered: boolean; queued: boolean }

export const commandOk = (v: unknown): CommandOk =>
  decode(obj({ delivered: flag, queued: flag }), v)
