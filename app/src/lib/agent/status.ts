import { bool, decode, int, nullable, obj, optional, str } from '../contract/decode'

// The agent's status page, as the box reads it (agent/src/status.rs is the
// writer). One JSON document on TCP 7787 of a machine the box does not run;
// this is the half of it the box acts on. Fields the agent adds later are
// ignored until a reader here wants them, and fields an older agent lacks
// decode to their fallbacks, so a fleet of mixed agent versions reads.

/** The port every agent answers on unless its config says otherwise. */
export const AGENT_PORT = 7787

export type AgentStatus = {
  version: string
  hostname: string
  os: string
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
}

const shape = obj({
  version: str,
  hostname: optional(str, ''),
  os: optional(str, ''),
  uptime_secs: optional(int, 0),
  os_uptime_secs: optional(nullable(int), null),
  booted_at: optional(nullable(str), null),
  awake_hold: optional(bool, false),
  hold_error: optional(nullable(str), null),
  update_available: optional(nullable(str), null),
  restart_pending: optional(bool, false),
  last_update_check: optional(nullable(str), null),
  last_update_result: optional(nullable(str), null),
})

/** Decode a status document; throws on a body that is not one. */
export function agentStatus(body: unknown): AgentStatus {
  const s = decode(shape, body)
  return {
    version: s.version,
    hostname: s.hostname,
    os: s.os,
    uptimeSecs: s.uptime_secs,
    osUptimeSecs: s.os_uptime_secs,
    bootedAt: s.booted_at,
    awakeHold: s.awake_hold,
    holdError: s.hold_error,
    updateAvailable: s.update_available,
    restartPending: s.restart_pending,
    lastUpdateCheck: s.last_update_check,
    lastUpdateResult: s.last_update_result,
  }
}
