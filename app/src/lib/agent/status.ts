import { arrayOf, bool, decode, int, nullable, num, obj, optional, str } from '../contract/decode'

// The agent's status page, as the box reads it (agent/src/status.rs is the
// writer). One JSON document on TCP 7787 of a machine the box does not run;
// this is the half of it the box acts on. Fields the agent adds later are
// ignored until a reader here wants them, and fields an older agent lacks
// decode to their fallbacks, so a fleet of mixed agent versions reads.

/** The port every agent answers on unless its config says otherwise. */
export const AGENT_PORT = 7787

/** What the box asked of the machine, as the agent holds it (agent 0.4.0+). */
export type AgentPolicy = {
  awakeHold: boolean
  claudeRemoteControl: boolean
}

/** One session on the node, from its `~/.claude/sessions` (agent/src/claude.rs). */
export type NodeClaudeSession = {
  pid: number
  transcriptId: string | null
  remoteId: string | null
  cwd: string | null
  name: string | null
  kind: string | null
  entrypoint: string | null
  version: string | null
  startedAt: number | null
  status: string | null
  lastActivityAt: number | null
  alive: boolean
}

/**
 * Claude Code on the node, as its tray reported it: the supervised
 * `claude remote-control`, the sessions, the credential clock (dates and a
 * plan name, never a token) and the model settings. Mirrors the box's own
 * ClaudeFacts where the two can agree.
 */
export type NodeClaude = {
  path: string | null
  cliVersion: string | null
  /** not-installed | off | starting | running | waiting | stopped */
  state: string
  detail: string | null
  pid: number | null
  startedAt: string | null
  restarts: number
  lastExit: string | null
  server: {
    version: string | null
    environmentId: string | null
    spawnMode: string | null
    maxSessions: number | null
  }
  sessions: NodeClaudeSession[]
  credentials: {
    present: boolean
    subscriptionType: string | null
    rateLimitTier: string | null
    expiresAt: number | null
    refreshExpiresAt: number | null
  }
  settings: { model: string | null; effortLevel: string | null }
  user: string | null
  home: string | null
  workdir: string | null
  /** "named", "most recent trusted project", or the home fallback with its reason. */
  workdirVia: string | null
  log: string | null
  reportedAt: string
}

export type AgentStatus = {
  version: string
  hostname: string
  os: string
  /** "Windows 11 Pro", "macOS"; empty from an agent older than 0.3.0. */
  osName: string
  /** "24H2 (26100.4652)", "15.1"; empty from an older agent. */
  osVersion: string
  arch: string
  cpu: string
  memoryBytes: number | null
  /** The agent process's uptime. */
  uptimeSecs: number
  /** The machine's; null from an agent older than 0.2.1. */
  osUptimeSecs: number | null
  bootedAt: string | null
  awakeHold: boolean
  holdError: string | null
  updateAvailable: string | null
  restartPending: boolean
  lastUpdateCheck: string | null
  lastUpdateResult: string | null
  /** The agent's policy; an agent older than 0.4.0 holds the machine awake and has no Claude. */
  policy: AgentPolicy
  /** Null when the tray has not reported lately (nobody logged on), or the agent predates it. */
  claude: NodeClaude | null
  /** Whether the tray — the user's session — is reporting to the service. */
  trayReporting: boolean
}

const nstr = optional(nullable(str), null)
const nint = optional(nullable(int), null)
const nnum = optional(nullable(num), null)

const session = obj({
  pid: int,
  transcript_id: nstr,
  remote_id: nstr,
  cwd: nstr,
  name: nstr,
  kind: nstr,
  entrypoint: nstr,
  version: nstr,
  started_at: nnum,
  status: nstr,
  last_activity_at: nnum,
  alive: optional(bool, false),
})

const claude = obj({
  path: nstr,
  cli_version: nstr,
  state: optional(str, 'stopped'),
  detail: nstr,
  pid: nint,
  started_at: nstr,
  restarts: optional(int, 0),
  last_exit: nstr,
  server: optional(
    obj({
      version: nstr,
      environment_id: nstr,
      spawn_mode: nstr,
      max_sessions: nint,
    }),
    { version: null, environment_id: null, spawn_mode: null, max_sessions: null },
  ),
  sessions: optional(arrayOf(session), []),
  credentials: optional(
    obj({
      present: optional(bool, false),
      subscription_type: nstr,
      rate_limit_tier: nstr,
      expires_at: nnum,
      refresh_expires_at: nnum,
    }),
    {
      present: false,
      subscription_type: null,
      rate_limit_tier: null,
      expires_at: null,
      refresh_expires_at: null,
    },
  ),
  settings: optional(obj({ model: nstr, effort_level: nstr }), { model: null, effort_level: null }),
  user: nstr,
  home: nstr,
  workdir: nstr,
  workdir_via: nstr,
  log: nstr,
  reported_at: optional(str, ''),
})

const shape = obj({
  version: str,
  hostname: optional(str, ''),
  os: optional(str, ''),
  os_name: optional(str, ''),
  os_version: optional(str, ''),
  arch: optional(str, ''),
  cpu: optional(str, ''),
  memory_bytes: nint,
  uptime_secs: optional(int, 0),
  os_uptime_secs: nint,
  booted_at: nstr,
  awake_hold: optional(bool, false),
  hold_error: nstr,
  update_available: nstr,
  restart_pending: optional(bool, false),
  last_update_check: nstr,
  last_update_result: nstr,
  policy: optional(
    obj({
      awake_hold: optional(bool, true),
      claude_remote_control: optional(bool, false),
    }),
    { awake_hold: true, claude_remote_control: false },
  ),
  claude: optional(nullable(claude), null),
  tray: optional(obj({ reporting: optional(bool, false) }), { reporting: false }),
})

function nodeClaude(c: NonNullable<ReturnType<typeof claude>>): NodeClaude {
  return {
    path: c.path,
    cliVersion: c.cli_version,
    state: c.state,
    detail: c.detail,
    pid: c.pid,
    startedAt: c.started_at,
    restarts: c.restarts,
    lastExit: c.last_exit,
    server: {
      version: c.server.version,
      environmentId: c.server.environment_id,
      spawnMode: c.server.spawn_mode,
      maxSessions: c.server.max_sessions,
    },
    sessions: c.sessions.map((s) => ({
      pid: s.pid,
      transcriptId: s.transcript_id,
      remoteId: s.remote_id,
      cwd: s.cwd,
      name: s.name,
      kind: s.kind,
      entrypoint: s.entrypoint,
      version: s.version,
      startedAt: s.started_at,
      status: s.status,
      lastActivityAt: s.last_activity_at,
      alive: s.alive,
    })),
    credentials: {
      present: c.credentials.present,
      subscriptionType: c.credentials.subscription_type,
      rateLimitTier: c.credentials.rate_limit_tier,
      expiresAt: c.credentials.expires_at,
      refreshExpiresAt: c.credentials.refresh_expires_at,
    },
    settings: { model: c.settings.model, effortLevel: c.settings.effort_level },
    user: c.user,
    home: c.home,
    workdir: c.workdir,
    workdirVia: c.workdir_via,
    log: c.log,
    reportedAt: c.reported_at,
  }
}

/** Decode a status document; throws on a body that is not one. */
export function agentStatus(body: unknown): AgentStatus {
  const s = decode(shape, body)
  return {
    version: s.version,
    hostname: s.hostname,
    os: s.os,
    osName: s.os_name,
    osVersion: s.os_version,
    arch: s.arch,
    cpu: s.cpu,
    memoryBytes: s.memory_bytes,
    uptimeSecs: s.uptime_secs,
    osUptimeSecs: s.os_uptime_secs,
    bootedAt: s.booted_at,
    awakeHold: s.awake_hold,
    holdError: s.hold_error,
    updateAvailable: s.update_available,
    restartPending: s.restart_pending,
    lastUpdateCheck: s.last_update_check,
    lastUpdateResult: s.last_update_result,
    policy: { awakeHold: s.policy.awake_hold, claudeRemoteControl: s.policy.claude_remote_control },
    claude: s.claude === null ? null : nodeClaude(s.claude),
    trayReporting: s.tray.reporting,
  }
}

/** Whether this agent version reports Claude Code and takes a policy (0.4.0 and up). */
export function agentHasClaude(version: string): boolean {
  const [major = 0, minor = 0] = version.split('.').map((p) => Number.parseInt(p, 10))
  return major > 0 || minor >= 4
}
