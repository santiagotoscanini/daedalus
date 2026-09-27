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
export const POLICY_DEFAULTS = { awakeHold: true, claudeRemoteControl: true } as const

export type EffectivePolicy = {
  awakeHold: boolean
  claudeRemoteControl: boolean
  claudeWorkdir: string | null
  providers: Record<ProviderKind, { port: number }>
}

export function effectivePolicy(p: NodePolicy): EffectivePolicy {
  return {
    awakeHold: p.awakeHold ?? POLICY_DEFAULTS.awakeHold,
    claudeRemoteControl: p.claudeRemoteControl ?? POLICY_DEFAULTS.claudeRemoteControl,
    claudeWorkdir: p.claudeWorkdir?.trim() || null,
    // Every kind a node can offer, with the port it would be probed on.
    providers: Object.fromEntries(
      NODE_PROVIDER_KINDS.map((k) => [k, { port: p.providers?.[k]?.port ?? DEFAULT_PORT[k] }]),
    ) as Record<ProviderKind, { port: number }>,
  }
}

/**
 * The agent's `Policy` on the wire, field for field. The controller
 * takes it exactly (wire.rs `DesiredPolicy`, deny_unknown_fields), so a key
 * it does not know would refuse the whole desired set.
 */
export type WirePolicy = {
  awake_hold: boolean
  claude_remote_control: boolean
  claude_workdir?: string
  providers: { lemonade: { port: number } }
}

export function wirePolicy(p: NodePolicy): WirePolicy {
  const e = effectivePolicy(p)
  return {
    awake_hold: e.awakeHold,
    claude_remote_control: e.claudeRemoteControl,
    ...(e.claudeWorkdir === null ? {} : { claude_workdir: e.claudeWorkdir }),
    // Where each provider listens, so the agent's presence probe asks the
    // right port.
    providers: { lemonade: { port: e.providers.lemonade.port } },
  }
}

/**
 * The one-shot instructions an admin can send a machine (link/wire.rs
 * `Command`): its updater looks for a release now; its session updates
 * Claude Code, which interrupts nothing; its session restarts `claude
 * remote-control`, which ends every session there.
 */
export const NODE_COMMANDS = ['check_update', 'claude_update', 'claude_restart'] as const
export type NodeCommand = (typeof NODE_COMMANDS)[number]
