import {
  type NodeClaude,
  type NodeTelemetry,
  nodeClaudeReport,
  nodeTelemetryFull,
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
  hello: boolean
  selfUpdate: boolean
  keepAwake: boolean
  installer: boolean
  session: boolean
  sessionInService: boolean
  claudeUpdate: boolean
  tray: boolean
  statusOnLan: boolean
  apiSocket: boolean
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
    hello: flag,
    self_update: flag,
    keep_awake: flag,
    installer: flag,
    session: flag,
    session_in_service: flag,
    claude_update: flag,
    tray: flag,
    status_on_lan: flag,
    api_socket: flag,
  }),
  telemetry: optional(str, 'off'),
  capabilities: optional(arrayOf(str), []),
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
      hello: r.hello,
      selfUpdate: r.self_update,
      keepAwake: r.keep_awake,
      installer: r.installer,
      session: r.session,
      sessionInService: r.session_in_service,
      claudeUpdate: r.claude_update,
      tray: r.tray,
      statusOnLan: r.status_on_lan,
      apiSocket: r.api_socket,
    },
    telemetry: s.telemetry,
    capabilities: s.capabilities,
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
  return { level: t.level, telemetry: t.telemetry === null ? null : nodeTelemetryFull(t.telemetry) }
}
