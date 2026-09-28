import { type AgentRoster, agentRoster } from '../../lib/agent/roster'
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
import {
  arrayOf,
  bool,
  decode,
  int,
  literal,
  nullable,
  num,
  obj,
  optional,
  reads,
  recordOf,
  str,
} from '../../lib/contract/decode'
import {
  type ModelFigures,
  modelOf,
  type ProviderBackend,
  type ProviderDownload,
  type ProviderHealth,
  type ProviderModel,
} from '../../lib/providers/kinds'
import type {
  ApiError,
  ClaudeSessionSent,
  CommandOk,
  Hello,
  HelloOk,
  Mode,
  NodeClaudeOk,
  NodeClaudeRosterOk,
  NodeDetail,
  NodeProvidersOk,
  NodeState,
  NodeSummary,
  NodeTelemetryOk,
  ProviderModelSent,
  Queued,
  RootRunOk,
  RootVerb,
  SessionQueued,
  SetDesiredOk,
  TelemetryLevel,
  ClaudeRosterGet as WireClaudeRosterGet,
  ClaudeStatus as WireClaudeStatus,
  ControllerInfo as WireControllerInfo,
  ProviderReport as WireProviderReport,
  SystemInfo as WireSystemInfo,
  TelemetryGet as WireTelemetryGet,
} from './generated'

// The controller's local API as this app reads it: agent/src/api/wire.rs is
// the writer and the contract. Its types are GENERATED from the Rust
// (agent/src/ts.rs → ./generated/, kept current by the agent's gate), and
// every decoder here is held to them (`reads`): a field the agent renames,
// drops or makes nullable is a compile error, not a page that reads nulls.
// wire.test.ts decodes the golden lines the agent's tests pin. The decoders
// stay the runtime half — the app deploys on save and the controller moves
// with a lock bump, so the two meet at different versions: a field the agent
// adds is ignored until a reader wants it, one a document lacks decodes to its
// fallback. The API version is what says they cannot talk at all
// (`API_VERSION`, the `version` error).
//
// Pure: no socket here. host/controller/client.ts is the connection.

export type {
  CommandOk,
  DesiredNode,
  HelloOk,
  Mode,
  NodeState,
  Queued,
  SetDesiredOk,
  TelemetryLevel,
} from './generated'

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
const flag = optional(bool, false)
const mode = literal('node', 'controller')
const level = literal('full', 'minimal', 'off')
const nodeState = literal('pending', 'approved', 'revoked', 'unknown')

// ── one line ────────────────────────────────────────────────────────────────

/** A line from the agent: an answer to `id`, or an event. */
export type Incoming =
  | { kind: 'ok'; id: number; ok: unknown }
  | { kind: 'err'; id: number | null; error: ControllerError }
  | { kind: 'event'; e: string; p: unknown }

const errShape = reads<ApiError>()(obj({ code: str, msg: optional(str, ''), supported: nint }))

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

const helloShape = reads<HelloOk>()(
  obj({
    api: int,
    version: str,
    mode,
    hostname: optional(str, ''),
    capabilities: optional(arrayOf(str), []),
  }),
)

/** `hello`'s answer: the generated type as it is, every field a word or a list. */
export const helloOk = (v: unknown): HelloOk => decode(helloShape, v)

/** Which parts of the agent run (role.rs `Role`). */
export type AgentRole = {
  mode: Mode
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
  /** The rotation under way — `publicKey` is then already the new key — or null. */
  rotation: ControllerRotation | null
}

/**
 * A key rotation under way (agent/src/link/rotation.rs): the key being
 * retired, when it retires (wall-clock), and how many machines still
 * connect under it — each has been sent the signed statement, so one that
 * stays runs an agent older than 0.19.0.
 */
export type ControllerRotation = {
  fromPublicKey: string
  fromFingerprint: string
  startedAt: string
  retiresAt: string
  oldKeyConnections: number
}

export type SystemInfo = {
  api: number
  version: string
  mode: Mode
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

const controllerShape = reads<WireControllerInfo>()(
  obj({
    public_key: str,
    fingerprint: str,
    listen: nstr,
    advertise: optional(arrayOf(str), []),
    rotation: optional(
      nullable(
        obj({
          from_public_key: str,
          from_fingerprint: str,
          started_at: optional(str, ''),
          retires_at: str,
          old_key_connections: optional(int, 0),
        }),
      ),
      null,
    ),
  }),
)

function controllerOf(c: ReturnType<typeof controllerShape>): ControllerInfo {
  const r = c.rotation
  return {
    publicKey: c.public_key,
    fingerprint: c.fingerprint,
    listen: c.listen,
    advertise: c.advertise,
    rotation:
      r === null
        ? null
        : {
            fromPublicKey: r.from_public_key,
            fromFingerprint: r.from_fingerprint,
            startedAt: r.started_at,
            retiresAt: r.retires_at,
            oldKeyConnections: r.old_key_connections,
          },
  }
}

/**
 * `controller.rotate`'s answer: the controller as `system.info` then states
 * it, its `rotation` set. The agent answers `unavailable` while a rotation
 * already runs.
 */
export const controllerRotated = (v: unknown): ControllerInfo =>
  controllerOf(decode(controllerShape, v))

const systemInfoShape = reads<WireSystemInfo>()(
  obj({
    api: int,
    version: str,
    mode,
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
      // The top-level mode stands in when a role leaves its own out.
      mode: optional(nullable(mode), null),
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
    telemetry: optional(level, 'off'),
    capabilities: optional(arrayOf(str), []),
    controller: optional(nullable(controllerShape), null),
  }),
)

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
      mode: r.mode ?? s.mode,
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
    controller: s.controller === null ? null : controllerOf(s.controller),
  }
}

/**
 * `claude.status`: the session's last report, the same document a node's
 * `/claude` answers (lib/agent/status.ts decodes both). `reporting` false
 * means no session reported lately, and `report` is null.
 */
export type ClaudeStatus = { reporting: boolean; wanted: boolean; report: NodeClaude | null }

const anyJson = optional(
  nullable((v: unknown) => v),
  null,
)

const claudeStatusShape = reads<WireClaudeStatus>()(
  obj({ reporting: flag, wanted: flag, report: anyJson }),
)

export function claudeStatus(v: unknown): ClaudeStatus {
  const s = decode(claudeStatusShape, v)
  return {
    reporting: s.reporting,
    wanted: s.wanted,
    report: s.report === null ? null : nodeClaudeReport(s.report),
  }
}

/** `claude.restart`: the instruction is queued for the session. */
export const queued = (v: unknown): Queued => decode(reads<Queued>()(obj({ queued: flag })), v)

/**
 * `telemetry.get`: the level config.toml sets and the latest document at it
 * — null at `off` and before the first sample. The document is the one a
 * node's `/telemetry` answers (lib/agent/status.ts).
 */
export type TelemetryGet = { level: TelemetryLevel; telemetry: NodeTelemetry | null }

const telemetryGetShape = reads<WireTelemetryGet>()(
  obj({ level: optional(level, 'off'), telemetry: anyJson }),
)

export function telemetryGet(v: unknown): TelemetryGet {
  const t = decode(telemetryGetShape, v)
  return { level: t.level, telemetry: t.telemetry === null ? null : nodeTelemetry(t.telemetry) }
}

// ── the machines (`nodes.*`) ────────────────────────────────────────────────

/**
 * A machine as `nodes.list` lists it. The hello's fields are null for a key
 * the app named that has not connected since the controller started — the
 * controller keeps nothing across a restart. `state` is `pending`
 * (connected, not decided), `approved`, `revoked`, or `unknown` (seen, not
 * decided, gone).
 */
export type ControllerNode = {
  id: string
  fingerprint: string
  state: NodeState
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

const nodeShape = {
  id: str,
  fingerprint: optional(str, ''),
  state: optional(nodeState, 'unknown'),
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

const nodeWire = reads<NodeSummary>()(obj(nodeShape))

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

const linkHelloShape = reads<Hello>()(
  obj({
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
    telemetry: optional(level, 'off'),
  }),
)

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

const nodeDetailShape = reads<NodeDetail>()(
  obj({
    ...nodeShape,
    public_key: str,
    hello: optional(nullable(linkHelloShape), null),
    status: anyJson,
    status_at: nstr,
    telemetry: anyJson,
    telemetry_at: nstr,
  }),
)

export function nodeDetail(v: unknown): ControllerNodeDetail {
  const d = decode(nodeDetailShape, v)
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

const nodeTelemetryShape = reads<NodeTelemetryOk>()(obj({ telemetry: anyJson, received_at: nstr }))

export function nodeTelemetryAnswer(v: unknown): NodeTelemetryAnswer {
  const t = decode(nodeTelemetryShape, v)
  return { telemetry: nodeTelemetry(t.telemetry), receivedAt: t.received_at }
}

/** `nodes.claude`: the machine's full Claude report, and when it arrived. */
export type NodeClaudeAnswer = { report: NodeClaude | null; receivedAt: string | null }

const nodeClaudeShape = reads<NodeClaudeOk>()(obj({ report: anyJson, received_at: nstr }))

export function nodeClaudeAnswer(v: unknown): NodeClaudeAnswer {
  const c = decode(nodeClaudeShape, v)
  return { report: nodeClaudeReport(c.report), receivedAt: c.received_at }
}

/**
 * `nodes.set_desired`'s answer: the ids whose open connection changed. The
 * set it takes is the generated `DesiredNode[]` — the controller refuses the
 * WHOLE set if an `id` is not its key's, so the builder (./nodes.ts) checks
 * that before sending.
 */
export function setDesiredOk(v: unknown): SetDesiredOk {
  const ids = optional(arrayOf(str), [])
  return decode(
    reads<SetDesiredOk>()(
      obj({ nodes: optional(int, 0), approved: ids, revoked: ids, pending: ids, policy: ids }),
    ),
    v,
  )
}

/** `nodes.command`'s answer: acknowledged now, or kept for the next connection. */
export const commandOk = (v: unknown): CommandOk =>
  decode(reads<CommandOk>()(obj({ delivered: flag, queued: flag })), v)

// ── Claude sessions (`claude.roster`, `claude.session`, `nodes.claude_*`) ────

/**
 * `claude.roster`: the controller's session's roster (lib/agent/roster.ts
 * decodes it), or `reporting` false and no roster.
 */
export type ClaudeRosterGet = { reporting: boolean; roster: AgentRoster | null }

const claudeRosterShape = reads<WireClaudeRosterGet>()(obj({ reporting: flag, roster: anyJson }))

export function claudeRosterGet(v: unknown): ClaudeRosterGet {
  const r = decode(claudeRosterShape, v)
  return { reporting: r.reporting, roster: agentRoster(r.roster) }
}

/** `nodes.claude_roster`: the machine's roster as it last pushed it, and when. */
export type NodeClaudeRosterAnswer = { roster: AgentRoster | null; receivedAt: string | null }

const nodeClaudeRosterShape = reads<NodeClaudeRosterOk>()(
  obj({ roster: anyJson, received_at: nstr }),
)

export function nodeClaudeRosterAnswer(v: unknown): NodeClaudeRosterAnswer {
  const r = decode(nodeClaudeRosterShape, v)
  return { roster: agentRoster(r.roster), receivedAt: r.received_at }
}

/**
 * A session verb, taken: `claude.session` queues it for the controller's
 * session, `nodes.claude_session` hands it to the machine. Either way the
 * roster's `actions` reports the outcome under `request`.
 */
export type SessionSent = { request: string }

export const sessionQueued = (v: unknown): SessionSent => ({
  request: decode(reads<SessionQueued>()(obj({ queued: flag, request: str })), v).request,
})

export const claudeSessionSent = (v: unknown): SessionSent => ({
  request: decode(reads<ClaudeSessionSent>()(obj({ delivered: flag, request: str })), v).request,
})

// ── Providers (`nodes.providers`, `nodes.provider_model`) ─────────────────

/**
 * One provider as a node's agent read it on its own loopback
 * (agent/src/providers.rs), in the app's shapes: the catalog with modes
 * derived from the labels, the health, and the page's detail.
 */
export type NodeProviderReport = {
  kind: string
  port: number
  version: string | null
  /** The health endpoint answered. */
  running: boolean
  /** And called itself healthy. */
  healthy: boolean
  loaded: ProviderHealth['loaded']
  models: ProviderModel[]
  downloads: ProviderDownload[]
  backends: ProviderBackend[]
  /** By the provider's model id. */
  figures: Record<string, ModelFigures>
  readAt: string
  error: string | null
  /** The residency verbs' outcomes, newest last. */
  actions: { request: string; model: string; ok: boolean; message: string; at: string }[]
}

/** `nodes.providers`: null `providers` until the machine has pushed a document. */
export type NodeProvidersAnswer = {
  connected: boolean
  providers: NodeProviderReport[] | null
  receivedAt: string | null
}

const nnum = optional(nullable(num), null)

const providerReportShape = reads<WireProviderReport>()(
  obj({
    kind: optional(str, ''),
    port: optional(int, 0),
    version: nstr,
    running: flag,
    healthy: flag,
    loaded: optional(arrayOf(obj({ id: str, device: nstr, max_context: nint, pinned: flag })), []),
    models: optional(
      arrayOf(
        obj({
          id: str,
          labels: optional(arrayOf(str), []),
          downloaded: flag,
          size_gb: nnum,
          recipe: nstr,
        }),
      ),
      [],
    ),
    downloads: optional(
      arrayOf(obj({ model: optional(str, '?'), percent: nnum, status: optional(str, '?') })),
      [],
    ),
    backends: optional(arrayOf(obj({ recipe: str, backend: str, version: nstr, url: nstr })), []),
    figures: optional(
      arrayOf(
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
      [],
    ),
    read_at: optional(str, ''),
    error: nstr,
    actions: optional(
      arrayOf(
        obj({
          request: str,
          model: optional(str, ''),
          ok: flag,
          message: optional(str, ''),
          at: optional(str, ''),
        }),
      ),
      [],
    ),
  }),
)

const nodeProvidersShape = reads<NodeProvidersOk>()(
  obj({
    connected: flag,
    providers: optional(nullable(arrayOf(providerReportShape)), null),
    received_at: nstr,
  }),
)

export function nodeProvidersAnswer(v: unknown): NodeProvidersAnswer {
  // The controller keeps only real reads (agent/src/providers.rs `check`
  // refuses an entry without its `read_at`), so a null here is "no report
  // yet" and an empty list is "the agent finds none".
  const d = decode(nodeProvidersShape, v)
  return {
    connected: d.connected,
    receivedAt: d.received_at,
    providers:
      d.providers === null
        ? null
        : d.providers
            .filter((p) => p.kind !== '' && p.port > 0)
            .map((p) => ({
              kind: p.kind,
              port: p.port,
              version: p.version,
              running: p.running,
              healthy: p.healthy,
              loaded: p.loaded.map((l) => ({
                id: l.id,
                device: l.device,
                maxContext: l.max_context,
                pinned: l.pinned,
              })),
              models: p.models.map((m) =>
                modelOf({
                  id: m.id,
                  labels: m.labels,
                  downloaded: m.downloaded,
                  sizeGb: m.size_gb,
                  recipe: m.recipe,
                }),
              ),
              downloads: p.downloads,
              backends: p.backends,
              figures: Object.fromEntries(
                p.figures.map((f) => [
                  f.model,
                  {
                    requests: f.requests,
                    inputTokens: f.input_tokens,
                    outputTokens: f.output_tokens,
                    tps: f.tps,
                    ttftMs: f.ttft_ms,
                    device: f.device,
                    checkpoint: f.checkpoint,
                  },
                ]),
              ),
              readAt: p.read_at,
              error: p.error,
              actions: p.actions,
            })),
  }
}

/** `nodes.provider_model`: taken; the providers document reports the outcome under `request`. */
export const providerModelSent = (v: unknown): { request: string } => ({
  request: decode(reads<ProviderModelSent>()(obj({ delivered: flag, request: str })), v).request,
})

// ── the root helper (`root.run`) ────────────────────────────────────────────

/** How a root verb ended (agent/src/root/mod.rs `Outcome`). */
export type RootOutcome = 'done' | 'refused' | 'failed'

/** One verb as the helper's `status` states it. */
export type RootVerbState = {
  verb: string
  unit: string
  description: string
  selectors: Record<string, string[]>
  /** The unit's ActiveState; null for a template, or when systemd did not answer. */
  activeState: string | null
  result: string | null
}

/** `root.run`'s answer: the run's id, how it ended, and for `status` every verb. */
export type RootRun = {
  run: string
  verb: string
  outcome: RootOutcome
  detail: string
  verbs: RootVerbState[]
}

const rootVerbShape = reads<RootVerb>()(
  obj({
    verb: str,
    unit: str,
    description: optional(str, ''),
    selectors: optional(recordOf(arrayOf(str)), {}),
    active_state: nstr,
    result: nstr,
  }),
)

const rootRunShape = reads<RootRunOk>()(
  obj({
    run: str,
    verb: str,
    outcome: literal('done', 'refused', 'failed'),
    detail: optional(str, ''),
    verbs: optional(arrayOf(rootVerbShape), []),
  }),
)

export function rootRunOk(v: unknown): RootRun {
  const r = decode(rootRunShape, v)
  return {
    run: r.run,
    verb: r.verb,
    outcome: r.outcome,
    detail: r.detail,
    verbs: r.verbs.map((x) => ({
      verb: x.verb,
      unit: x.unit,
      description: x.description,
      selectors: x.selectors,
      activeState: x.active_state,
      result: x.result,
    })),
  }
}
