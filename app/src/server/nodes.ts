import type { NodePolicy } from '../host/schema'
import { asValidator, is, obj, withMessage } from '../lib/contract/decode'
import { nodeIdField } from '../lib/contract/fields-c'
import { CHOSEN_KINDS, isChosenPart, isFinish } from '../lib/hardware/catalog'
import { NODE_NAME_RE } from '../lib/nodes-file'
import { isProviderKind } from '../lib/providers/kinds'
import { modelPolicies } from '../lib/providers/policy'
import { adminFn, readFn } from './fn'

// Server functions behind Settings › Machines: the page's one read, and
// its decisions about a node — approve, revoke, forget, the policy. Each
// write is an admin action under the gate, and each records who made it.
// Value imports are dynamic, like every other server module here — the
// repository reaches the database.

const nodeId = asValidator(withMessage(obj({ id: nodeIdField }), 'expected a node id'))

export const approveNodeFn = adminFn.validator(nodeId).handler(async ({ data, context }) => {
  const { approveNode } = await import('../lib/repo/nodes')
  return { ok: await approveNode(data.id, context.actor()) }
})

export const revokeNodeFn = adminFn.validator(nodeId).handler(async ({ data }) => {
  const { revokeNode } = await import('../lib/repo/nodes')
  return { ok: await revokeNode(data.id) }
})

export const forgetNodeFn = adminFn.validator(nodeId).handler(async ({ data }) => {
  const { forgetNode } = await import('../lib/repo/nodes')
  return { ok: await forgetNode(data.id) }
})

export const requestUpdateCheckFn = adminFn.validator(nodeId).handler(async ({ data }) => {
  const { requestUpdateCheck } = await import('../lib/repo/nodes')
  return { ok: await requestUpdateCheck(data.id) }
})

/**
 * Ask the node to update Claude Code on its next hello.
 *
 * The harmless half of the pair: the new CLI installs beside the running
 * one and the machine keeps working. Its sibling below moves the server
 * onto it and ends every session there.
 */
export const requestClaudeUpdateFn = adminFn.validator(nodeId).handler(async ({ data }) => {
  const { requestClaudeUpdate } = await import('../lib/repo/nodes')
  return { ok: await requestClaudeUpdate(data.id) }
})

export const requestClaudeRestartFn = adminFn.validator(nodeId).handler(async ({ data }) => {
  const { requestClaudeRestart } = await import('../lib/repo/nodes')
  return { ok: await requestClaudeRestart(data.id) }
})

/**
 * Settings › Machines' cards: every node with its policy, joined to what the
 * LAN answered just now. Read-only, so no gate beyond the page's. Built on a
 * Ctx the way the module boards are — the reader asks pi-hole for the LAN.
 */
export const fetchMachinesFn = readFn.handler(async ({ context }) => {
  const { loadMachines } = await import('../lib/dashboard/machines')
  return loadMachines(await context.ctx())
})

const NAME_MAX = 40
/** A Windows path; MAX_PATH is 260 and nothing here needs longer. */
const PATH_MAX = 260

/**
 * A policy from the page. Every key optional and every value checked: the
 * display name is one line of bounded length, the two switches booleans.
 * Unknown keys are dropped rather than stored, so the row never carries
 * what the agent would not understand.
 */
const nodePolicy = (data: unknown): { id: string; policy: NodePolicy } => {
  const { id } = nodeId(data)
  const p = (data as { policy?: unknown }).policy
  if (typeof p !== 'object' || p === null) throw new Error('expected a policy')
  const o = p as Record<string, unknown>
  const policy: NodePolicy = {}
  if (o.displayName !== undefined) {
    if (typeof o.displayName !== 'string') throw new Error('displayName must be text')
    const name = o.displayName.trim().replace(/\s+/g, ' ')
    if (name.length > NAME_MAX) throw new Error(`displayName is longer than ${String(NAME_MAX)}`)
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
  for (const k of ['awakeHold', 'claudeRemoteControl'] as const) {
    if (o[k] !== undefined) {
      if (typeof o[k] !== 'boolean') throw new Error(`${k} must be true or false`)
      policy[k] = o[k]
    }
  }
  return { id, policy }
}

export const saveNodePolicyFn = adminFn.validator(nodePolicy).handler(async ({ data }) => {
  const { setNodePolicy } = await import('../lib/repo/nodes')
  return { ok: await setNodePolicy(data.id, data.policy) }
})

/**
 * What an Apply would do about the machines: the fields the bar shows
 * ("gaming-pc offers lemonade"), or none when site/nodes.json already
 * holds what the table would render.
 */
export const fetchNodesChangeFn = readFn.handler(async (): Promise<string[]> => {
  const { nodesChange } = await import('../host/apply-flow')
  const c = await nodesChange()
  return c.changed ? c.fields : []
})

/* ── the gateway: providers' models and the sync ──────────────────────── */

/**
 * What a node's provider serves, read from the provider itself, with each
 * model as the operator's policy leaves it. For the models table on
 * Settings › Machines. Read-only; a node the box does not know answers an
 * empty list.
 */
const nodeProvider = asValidator(
  withMessage(
    obj({
      id: nodeIdField,
      kind: withMessage(is(isProviderKind, 'a provider kind'), 'kind is not a provider kind'),
    }),
    'expected a node id',
  ),
)

export const fetchProviderModelsFn = readFn
  .validator(nodeProvider)
  .handler(async ({ data, context }) => {
    const { fleetProviders } = await import('../host/providers/fleet')
    const { readProvider } = await import('../host/providers/read')
    const { resolveModel } = await import('../lib/providers/policy')
    const { getNode } = await import('../lib/repo/nodes')
    const ctx = await context.ctx()
    const node = await getNode(data.id)
    const provider = (await fleetProviders(ctx)).find(
      (p) => p.machine === data.id && p.kind === data.kind,
    )
    if (provider === undefined || node === null) {
      return { reachable: false, error: 'no provider on this machine', version: null, models: [] }
    }
    const reading = await readProvider(ctx, provider.kind, provider.base)
    const policies = node.policy.providers?.[data.kind]?.models
    return {
      reachable: reading.reachable,
      error: reading.error,
      version: reading.health.version,
      models: reading.models.map((m) => ({
        ...m,
        loaded: reading.health.loaded.some((l) => l.id === m.id),
        ...resolveModel(policies, m),
        defaultAlias: resolveModel(undefined, m).alias,
      })),
    }
  })

/** The last gateway sync's summary, for the line under the models table. */
export const fetchGatewaySyncFn = readFn.handler(async () => {
  const { lastGatewaySync } = await import('../host/gateway-sync')
  return lastGatewaySync()
})

/** "Sync now": one reconcile, awaited, its summary returned. */
export const runGatewaySyncFn = adminFn.handler(async ({ context }) => {
  const { syncGateway } = await import('../host/gateway-sync')
  return syncGateway(await context.ctx())
})

/** This box's own provider policy (subgen): offered or not, and its alias. */
export const fetchBoxProvidersFn = readFn.handler(async ({ context }) => {
  const { BOX_PROVIDERS_KEY, isBoxProviderPolicy } = await import('../lib/providers/policy')
  const ctx = await context.ctx()
  const policy = (await ctx.store.read(BOX_PROVIDERS_KEY, isBoxProviderPolicy)) ?? {}
  return { present: ctx.modules.enabled('tv'), policy }
})

const boxProviders = (data: unknown): { subgen: { offer: boolean; alias: string } } => {
  if (typeof data !== 'object' || data === null) throw new Error('expected a policy')
  const s = (data as { subgen?: unknown }).subgen
  if (typeof s !== 'object' || s === null) throw new Error('expected subgen')
  const { offer, alias } = s as Record<string, unknown>
  if (typeof offer !== 'boolean') throw new Error('subgen.offer must be true or false')
  if (typeof alias !== 'string') throw new Error('subgen.alias must be text')
  const a = alias.trim().toLowerCase()
  const checked = modelPolicies({ whisper: { alias: a } })
  return { subgen: { offer, alias: checked.whisper?.alias ?? '' } }
}

export const saveBoxProvidersFn = adminFn
  .validator(boxProviders)
  .handler(async ({ data, context }) => {
    const { BOX_PROVIDERS_KEY } = await import('../lib/providers/policy')
    const { requestGatewaySync } = await import('../host/gateway-sync')
    const ctx = await context.ctx()
    await ctx.store.write(BOX_PROVIDERS_KEY, {
      subgen: {
        offer: data.subgen.offer,
        models: data.subgen.alias === '' ? {} : { whisper: { alias: data.subgen.alias } },
      },
    })
    requestGatewaySync()
    return { ok: true }
  })
