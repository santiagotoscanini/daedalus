import type { NodePolicy } from '../../host/schema'
import { nodeIdField } from '../contract/fields'
import { CHOSEN_KINDS, isChosenPart, isFinish } from '../hardware/catalog'
import { NODE_NAME_RE } from '../nodes-file'
import { isProviderKind } from '../providers/kinds'
import { modelPolicies } from '../providers/policy'
import { hasControlChar } from './policy'

// What Settings › Machines may change in a machine's policy, checked: one
// change by key (lib/repo/nodes.ts `PolicyPatch`), as server/nodes.ts
// `saveNodePolicyFn` takes it. Pure, so the rules are tested here rather
// than through a server function.

const NAME_MAX = 40
/** A Windows path; MAX_PATH is 260 and nothing here needs longer. */
const PATH_MAX = 260

/**
 * The keys a page may set or clear: every key `checkedPolicy` reads. A key
 * outside them is refused rather than stored, so the row never carries what
 * the agent would not understand.
 */
const POLICY_KEYS = [
  'displayName',
  'name',
  'pinAddress',
  'providers',
  'claudeWorkdir',
  'hardware',
  'awakeHold',
  'claudeRemoteControl',
  'santree',
] as const satisfies readonly (keyof NodePolicy)[]

const isPolicyKey = (k: unknown): k is (typeof POLICY_KEYS)[number] =>
  typeof k === 'string' && (POLICY_KEYS as readonly string[]).includes(k)

/**
 * A change from the page, by key (lib/repo/nodes.ts `PolicyPatch`): `set`
 * the keys it changes, `unset` the keys it clears. Every value is checked —
 * text bounded and on one line, switches booleans, providers by known kind,
 * hardware from the catalog — and a key set to nothing (a name emptied) is
 * cleared. santree is never set ON here: that is `grantSantreeFn`, behind
 * its confirmation.
 */
export const nodePolicyPatch = (
  data: unknown,
): { id: string; set: NodePolicy; unset: (keyof NodePolicy)[] } => {
  const id = nodeIdField((data as { id?: unknown }).id, 'id')
  const raw = (data as { set?: unknown }).set ?? {}
  const rawUnset = (data as { unset?: unknown }).unset ?? []
  if (!Array.isArray(rawUnset)) throw new Error('unset must be a list of keys')
  for (const k of rawUnset) {
    if (!isPolicyKey(k)) throw new Error(`unset: ${String(k)} is not a policy key`)
  }
  if (typeof raw !== 'object' || raw === null) throw new Error('expected the keys to set')
  for (const k of Object.keys(raw)) {
    if (!isPolicyKey(k)) throw new Error(`${k} is not a policy key`)
  }
  const set = checkedPolicy(raw as Record<string, unknown>)
  if (set.santree === true) {
    throw new Error('santree is turned on through its confirmation, never a policy patch')
  }
  // A key given and emptied (a name cleared) goes back to its default.
  const emptied = Object.keys(raw).filter((k) => !(k in set)) as (keyof NodePolicy)[]
  const unset = [...new Set([...(rawUnset as (keyof NodePolicy)[]), ...emptied])].filter(
    (k) => !(k in set),
  )
  if (Object.keys(set).length === 0 && unset.length === 0) throw new Error('nothing to change')
  return { id, set, unset }
}

/** The checked values of the keys a page sent (`nodePolicyPatch`). */
function checkedPolicy(o: Record<string, unknown>): NodePolicy {
  const policy: NodePolicy = {}
  if (o.displayName !== undefined) {
    if (typeof o.displayName !== 'string') throw new Error('displayName must be text')
    const name = o.displayName.trim().replace(/\s+/g, ' ')
    if (name.length > NAME_MAX) throw new Error(`displayName is longer than ${String(NAME_MAX)}`)
    // The controller labels the machine's metrics with it and refuses a
    // control character (lib/agent/policy.ts `wireName`).
    if (hasControlChar(name)) throw new Error('displayName has a control character')
    if (name !== '') policy.displayName = name
  }
  if (o.name !== undefined) {
    if (typeof o.name !== 'string') throw new Error('name must be text')
    const label = o.name.trim().toLowerCase()
    if (label !== '') {
      if (!NODE_NAME_RE.test(label)) {
        throw new Error('name must be a DNS label: letters, digits and hyphens, 1 to 32 long')
      }
      policy.name = label
    }
  }
  if (o.pinAddress !== undefined) {
    if (typeof o.pinAddress !== 'boolean') throw new Error('pinAddress must be true or false')
    if (o.pinAddress) policy.pinAddress = true
  }
  if (o.providers !== undefined) {
    if (typeof o.providers !== 'object' || o.providers === null) {
      throw new Error('providers must be an object')
    }
    // By kind, so a machine can offer whatever the gateway knows how to read
    // — a name that is not a kind is refused rather than stored and ignored.
    const providers: NonNullable<NodePolicy['providers']> = {}
    for (const [kind, raw] of Object.entries(o.providers as Record<string, unknown>)) {
      if (!isProviderKind(kind)) throw new Error(`providers.${kind} is not a provider kind`)
      if (typeof raw !== 'object' || raw === null) {
        throw new Error(`providers.${kind} must be an object`)
      }
      const { port, offer, models } = raw as Record<string, unknown>
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error(`providers.${kind}.port must be a port number`)
      }
      if (typeof offer !== 'boolean') {
        throw new Error(`providers.${kind}.offer must be true or false`)
      }
      providers[kind] =
        models === undefined ? { port, offer } : { port, offer, models: modelPolicies(models) }
    }
    if (Object.keys(providers).length > 0) policy.providers = providers
  }
  if (o.claudeWorkdir !== undefined) {
    if (typeof o.claudeWorkdir !== 'string') throw new Error('claudeWorkdir must be text')
    const dir = o.claudeWorkdir.trim()
    if (dir.length > PATH_MAX) throw new Error(`claudeWorkdir is longer than ${String(PATH_MAX)}`)
    if (/[\r\n]/.test(dir)) throw new Error('claudeWorkdir must be one line')
    if (dir !== '') policy.claudeWorkdir = dir
  }
  if (o.hardware !== undefined) {
    if (typeof o.hardware !== 'object' || o.hardware === null) {
      throw new Error('hardware must be an object')
    }
    const h = o.hardware as Record<string, unknown>
    const hardware: NonNullable<NodePolicy['hardware']> = {}
    for (const kind of CHOSEN_KINDS) {
      const id = h[kind]
      if (id === undefined || id === null || id === '') continue
      if (!isChosenPart(kind, id)) throw new Error(`${kind}: not a part the catalog knows`)
      hardware[kind] = id
    }
    if (h.finish !== undefined && h.finish !== null && h.finish !== '') {
      if (!isFinish(h.finish)) throw new Error('finish: not a colour the catalog knows')
      hardware.finish = h.finish
    }
    if (Object.keys(hardware).length > 0) policy.hardware = hardware
  }
  for (const k of ['awakeHold', 'claudeRemoteControl', 'santree'] as const) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== 'boolean') throw new Error(`${k} must be true or false`)
      policy[k] = o[k]
    }
  }
  return policy
}
