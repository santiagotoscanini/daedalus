import type { NodePolicy } from '../host/schema'
import { hasControlChar, NODE_COMMANDS, ROTATION_GRACE, ROTATION_GRACES } from '../lib/agent/policy'
import { asValidator, is, literal, obj, withMessage } from '../lib/contract/decode'
import { nodeIdField } from '../lib/contract/fields'
import { CHOSEN_KINDS, isChosenPart, isFinish } from '../lib/hardware/catalog'
import { NODE_NAME_RE } from '../lib/nodes-file'
import { isProviderKind } from '../lib/providers/kinds'
import { modelPolicies } from '../lib/providers/policy'
import { adminFn, readFn } from './fn'

// Server functions behind Settings › Machines: the cards, the decisions about
// a machine — approve (recorded under who made it), revoke, forget, the
// policy, the one-shot commands — and the gateway's provider models and sync.

const nodeId = asValidator(withMessage(obj({ id: nodeIdField }), 'expected a node id'))

/**
 * Approve a machine. A revoked row is trusted again; a key the controller
 * holds pending becomes a row, from its key and its hello. Either way the
 * desired set follows, and the controller upgrades the open connection.
 */
export const approveNodeFn = adminFn.validator(nodeId).handler(async ({ data, context }) => {
  const { approveNode, enrollNode } = await import('../lib/repo/nodes')
  if (await approveNode(data.id, context.actor())) return { ok: true }
  const ctx = await context.ctx()
  return { ok: await enrollNode(await ctx.controller.nodesGet(data.id), context.actor()) }
})

export const revokeNodeFn = adminFn.validator(nodeId).handler(async ({ data }) => {
  const { revokeNode } = await import('../lib/repo/nodes')
  return { ok: await revokeNode(data.id) }
})

export const forgetNodeFn = adminFn.validator(nodeId).handler(async ({ data }) => {
  const { forgetNode } = await import('../lib/repo/nodes')
  return { ok: await forgetNode(data.id) }
})

/**
 * One instruction to one machine, through the controller: the machine
 * acknowledges it at once when connected, or the controller keeps it for
 * the next connection. `claude_update` interrupts nothing; `claude_restart`
 * ends every session on the machine — the page names which it is.
 */
export const sendNodeCommandFn = adminFn
  .validator(
    asValidator(
      withMessage(
        obj({ id: nodeIdField, command: literal(...NODE_COMMANDS) }),
        'expected a node id and a command',
      ),
    ),
  )
  .handler(async ({ data, context }) => {
    const ctx = await context.ctx()
    return ctx.controller.nodesCommand(data.id, data.command)
  })

/**
 * Rotate the controller's key (`controller.rotate`): a new key at once, both
 * served for the grace, the old one retired after it. Machines on agent
 * 0.19.0 or newer re-pin themselves when they next connect; an older one is
 * re-pinned by hand. The controller refuses while a rotation runs.
 */
export const rotateControllerKeyFn = adminFn
  .validator(
    asValidator(
      withMessage(obj({ grace: literal(...ROTATION_GRACES) }), 'expected a grace period'),
    ),
  )
  .handler(async ({ data, context }) => {
    const ctx = await context.ctx()
    const c = await ctx.controller.controllerRotate({ grace_secs: ROTATION_GRACE[data.grace].secs })
    return { fingerprint: c.fingerprint, retiresAt: c.rotation?.retiresAt ?? null }
  })

/**
 * Settings › Machines' cards: every decided machine with its policy, and the
 * keys waiting at the controller. Read-only, so no gate beyond the page's.
 */
export const fetchMachinesFn = readFn.handler(async ({ context }) => {
  const { loadMachines } = await import('../lib/dashboard/machines')
  return loadMachines(await context.ctx())
})

const NAME_MAX = 40
/** A Windows path; MAX_PATH is 260 and nothing here needs longer. */
const PATH_MAX = 260

/**
 * A policy from the page. Every key optional and every value checked — text
 * bounded and on one line, switches booleans, providers by known kind,
 * hardware from the catalog. Unknown keys are dropped rather than stored, so
 * the row never carries what the agent would not understand.
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

/* ── the session host ─────────────────────────────────────────────────── */

/** The session host's line, afresh: what the restart's confirm counts. Null on a box without one. */
export const fetchSessionHostFn = readFn.handler(async ({ context }) => {
  const { readSessionHost } = await import('../host/session-host')
  return readSessionHost(await context.ctx())
})

/**
 * Restart the session host (the root helper's `session-host-restart`), which
 * is how a new build takes over. Every live terminal ends; the page names how
 * many before the click. Answers once the unit has finished.
 */
export const restartSessionHostFn = adminFn.handler(async ({ context }) => {
  const { restartSessionHost } = await import('../host/session-host')
  return restartSessionHost(await context.ctx(), { actor: context.actor() })
})

/* ── the gateway: providers' models and the sync ──────────────────────── */

const nodeProvider = asValidator(
  withMessage(
    obj({
      id: nodeIdField,
      kind: withMessage(is(isProviderKind, 'a provider kind'), 'kind is not a provider kind'),
    }),
    'expected a node id',
  ),
)

/**
 * What a node's provider serves, as its agent last reported it, with each
 * model as the operator's policy leaves it. For the models table on
 * Settings › Machines. Read-only; a node the box does not know answers an
 * empty list.
 */
export const fetchProviderModelsFn = readFn
  .validator(nodeProvider)
  .handler(async ({ data, context }) => {
    const { fleetProviders } = await import('../host/providers/fleet')
    const { nodeReading } = await import('../host/providers/read')
    const { resolveModel } = await import('../lib/providers/policy')
    const { getNode } = await import('../lib/repo/nodes')
    const ctx = await context.ctx()
    const node = await getNode(ctx, data.id)
    const provider = (await fleetProviders(ctx)).find(
      (p) => p.machine === data.id && p.kind === data.kind,
    )
    if (provider === undefined || node === null) {
      return { reachable: false, error: 'no provider on this machine', version: null, models: [] }
    }
    const reading = nodeReading(
      provider.kind,
      provider.base,
      await ctx.controller
        .nodesProviders(data.id)
        .catch((e: unknown) => (e instanceof Error ? e : new Error(String(e)))),
    )
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
