import { createServerFn } from '@tanstack/react-start'
import { actorLabel } from '../core/auth'
import type { NodePolicy } from '../host/schema'
import { CHOSEN_KINDS, isChosenPart, isFinish } from '../lib/hardware/catalog'
import { NODE_NAME_RE } from '../lib/nodes-file'

// Server functions behind Settings › Machines: the page's one read, and
// its decisions about a node — approve, revoke, forget, the policy. Each
// write is an admin action under the gate, and each records who made it.
// Value imports are dynamic, like every other server module here — the
// repository reaches the database.

const NODE_ID = /^[0-9a-f]{16}$/

const nodeId = (data: unknown): { id: string } => {
  const id = (data as { id?: unknown } | null)?.id
  if (typeof id !== 'string' || !NODE_ID.test(id)) throw new Error('expected a node id')
  return { id }
}

export const approveNodeFn = createServerFn({ method: 'POST' })
  .validator(nodeId)
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { approveNode } = await import('../lib/repo/nodes')
    return { ok: await approveNode(data.id, actorLabel()) }
  })

export const revokeNodeFn = createServerFn({ method: 'POST' })
  .validator(nodeId)
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { revokeNode } = await import('../lib/repo/nodes')
    return { ok: await revokeNode(data.id) }
  })

export const forgetNodeFn = createServerFn({ method: 'POST' })
  .validator(nodeId)
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { forgetNode } = await import('../lib/repo/nodes')
    return { ok: await forgetNode(data.id) }
  })

export const requestUpdateCheckFn = createServerFn({ method: 'POST' })
  .validator(nodeId)
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { requestUpdateCheck } = await import('../lib/repo/nodes')
    return { ok: await requestUpdateCheck(data.id) }
  })

export const requestClaudeRestartFn = createServerFn({ method: 'POST' })
  .validator(nodeId)
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { requestClaudeRestart } = await import('../lib/repo/nodes')
    return { ok: await requestClaudeRestart(data.id) }
  })

/**
 * Settings › Machines' cards: every node with its policy, joined to what the
 * LAN answered just now. Read-only, so no gate beyond the page's. Built on a
 * Ctx the way the module boards are — the reader asks pi-hole for the LAN.
 */
export const fetchMachinesFn = createServerFn().handler(async () => {
  const { makeCtx } = await import('../core/ctx')
  const { loadMachines } = await import('../lib/dashboard/machines')
  return loadMachines(await makeCtx())
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
    const l = (o.providers as Record<string, unknown>).lemonade
    if (l !== undefined) {
      if (typeof l !== 'object' || l === null)
        throw new Error('providers.lemonade must be an object')
      const { port, offer } = l as Record<string, unknown>
      if (typeof port !== 'number' || !Number.isInteger(port) || port < 1 || port > 65535) {
        throw new Error('providers.lemonade.port must be a port number')
      }
      if (typeof offer !== 'boolean')
        throw new Error('providers.lemonade.offer must be true or false')
      policy.providers = { lemonade: { port, offer } }
    }
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

export const saveNodePolicyFn = createServerFn({ method: 'POST' })
  .validator(nodePolicy)
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { setNodePolicy } = await import('../lib/repo/nodes')
    return { ok: await setNodePolicy(data.id, data.policy) }
  })

/**
 * What an Apply would do about the machines: the fields the bar shows
 * ("gaming-pc offers lemonade"), or none when site/nodes.json already
 * holds what the table would render.
 */
export const fetchNodesChangeFn = createServerFn().handler(async (): Promise<string[]> => {
  const { nodesChange } = await import('../host/apply-flow')
  const c = await nodesChange()
  return c.changed ? c.fields : []
})
