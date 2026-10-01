import { NODE_COMMANDS, ROTATION_GRACE, ROTATION_GRACES } from '../lib/agent/policy'
import { nodePolicyPatch } from '../lib/agent/policy-patch'
import { asValidator, is, literal, obj, str, withMessage } from '../lib/contract/decode'
import { nodeIdField } from '../lib/contract/fields'
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
  if (await approveNode(data.id, context.actor)) return { ok: true }
  const ctx = await context.ctx()
  return { ok: await enrollNode(await ctx.controller.nodesGet(data.id), context.actor) }
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
 * served for the grace, the old one retired after it. Machines re-pin
 * themselves when they next connect. The controller refuses while a rotation runs.
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

/** A change to a policy, recorded under who made it (the card's "Last changed by"). */
export const saveNodePolicyFn = adminFn
  .validator(nodePolicyPatch)
  .handler(async ({ data, context }) => {
    const { setNodePolicy } = await import('../lib/repo/nodes')
    return {
      ok: await setNodePolicy(data.id, { set: data.set, unset: data.unset }, context.actor),
    }
  })

/**
 * Turn santree on for a machine: a shell on the box as its operator, who
 * has root through sudo. The admin confirms on a page that shows the
 * machine and its key, and lib/repo/nodes.ts `grantSantree` checks the key
 * the page showed against the row.
 * The web switch and a Mac's "santree on the box" both arrive here, through
 * the Machines page's confirmation. Answers once the controller has the set.
 */
export const grantSantreeFn = adminFn
  .validator(
    asValidator(
      withMessage(obj({ id: nodeIdField, fingerprint: str }), 'expected a node id and its key'),
    ),
  )
  .handler(async ({ data, context }) => {
    const { grantSantree } = await import('../lib/repo/nodes')
    if (data.fingerprint.length > 100) {
      return { ok: false as const, reason: 'That is not a key.' }
    }
    return grantSantree({ ...data, by: context.actor })
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
  return restartSessionHost(await context.ctx(), { actor: context.actor })
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
