import type { Command, DesiredPolicy } from '../../host/controller/generated'
import { MAX_NODE_NAME } from '../../host/controller/generated/constants'
import type { NodePolicy } from '../../host/schema'
import { DEFAULT_PORT, NODE_PROVIDER_KINDS, type ProviderKind } from '../providers/kinds'

// What the box asks of a machine, as the machine hears it. The row's policy
// (host/schema.ts `NodePolicy`) holds more than the agent is told — names,
// hardware, which providers are offered and their models are the box's own
// business — so this is the one place that cuts it down to the agent's
// `DesiredPolicy` (agent/src/api/wire.rs), every key resolved.
//
// Pure: the controller's desired set (host/controller/nodes.ts) sends it, and
// the pages show the same defaults.

/** The agent's own defaults, which a key the policy leaves unset falls back to. */
export const POLICY_DEFAULTS = {
  awakeHold: true,
  claudeRemoteControl: true,
  santree: false,
} as const

export type EffectivePolicy = {
  awakeHold: boolean
  claudeRemoteControl: boolean
  claudeWorkdir: string | null
  santree: boolean
  providers: Record<ProviderKind, { port: number }>
}

export function effectivePolicy(p: NodePolicy): EffectivePolicy {
  return {
    awakeHold: p.awakeHold ?? POLICY_DEFAULTS.awakeHold,
    claudeRemoteControl: p.claudeRemoteControl ?? POLICY_DEFAULTS.claudeRemoteControl,
    claudeWorkdir: p.claudeWorkdir?.trim() || null,
    santree: p.santree ?? POLICY_DEFAULTS.santree,
    // Every kind a node can offer, with the port it would be probed on.
    providers: Object.fromEntries(
      NODE_PROVIDER_KINDS.map((k) => [k, { port: p.providers?.[k]?.port ?? DEFAULT_PORT[k] }]),
    ) as Record<ProviderKind, { port: number }>,
  }
}

/**
 * The machine's policy as the controller takes it (`DesiredPolicy`, generated
 * from wire.rs): the agent's `Policy`, and whether the gateway is offered the
 * machine's lemonade — which the controller keeps for `/nodes/metrics` (the
 * "Model Server Down" alert fires on offered ones) and the machine is not told.
 */
export function wirePolicy(p: NodePolicy): DesiredPolicy {
  const e = effectivePolicy(p)
  return {
    policy: {
      awake_hold: e.awakeHold,
      claude_remote_control: e.claudeRemoteControl,
      ...(e.claudeWorkdir === null ? {} : { claude_workdir: e.claudeWorkdir }),
      santree: e.santree,
      // Where each provider listens, so the agent reads the right port.
      providers: { lemonade: { port: e.providers.lemonade.port } },
    },
    offer_lemonade: p.providers?.lemonade?.offer === true,
  }
}

/** A Unicode control character (Cc), which the controller refuses in a name. */
export function hasControlChar(s: string): boolean {
  for (const ch of s) {
    const c = ch.codePointAt(0) ?? 0
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f)) return true
  }
  return false
}

/**
 * What the pages call the machine, as `nodes.set_desired` takes it: the
 * policy's display name, which the controller labels the machine's series
 * in `/nodes/metrics` with (`machine`). Absent when there is none — the
 * controller then uses the hostname, as the pages do — or when it is not a
 * name the controller would take (blank, longer than 64 characters, a
 * control character), since one bad entry refuses the whole set.
 */
export function wireName(p: NodePolicy): string | undefined {
  const name = p.displayName?.trim() ?? ''
  if (name === '' || [...name].length > MAX_NODE_NAME || hasControlChar(name)) return undefined
  return name
}

/**
 * The one-shot instructions an admin can send a machine (link/wire.rs
 * `Command`, generated): its updater looks for a release now; its session
 * updates Claude Code, which interrupts nothing; its session restarts `claude
 * remote-control`, which ends every session under it — and resumes them by
 * itself once the server is back. A record over the generated union, so a
 * command the agent adds is a compile error here until it is listed.
 */
const COMMANDS: Record<Command, true> = {
  check_update: true,
  claude_update: true,
  claude_restart: true,
}
export const NODE_COMMANDS = Object.keys(COMMANDS) as Command[]

/**
 * How long a controller key rotation serves both keys before the old one
 * retires, as Settings › Machines offers it (link/rotation.rs takes 60 s to
 * 90 days). A week is the agent's own default: long enough for a machine
 * that is off for a few days to connect once and re-pin itself.
 */
export const ROTATION_GRACE = {
  '1d': { label: '1 day', secs: 86_400 },
  '7d': { label: '7 days', secs: 7 * 86_400 },
  '30d': { label: '30 days', secs: 30 * 86_400 },
} as const
export type RotationGrace = keyof typeof ROTATION_GRACE
export const ROTATION_GRACES = Object.keys(ROTATION_GRACE) as RotationGrace[]
