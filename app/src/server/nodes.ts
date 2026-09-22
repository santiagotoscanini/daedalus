import { createServerFn } from '@tanstack/react-start'
import { actorLabel } from '../core/auth'

// Server functions behind System › Machines' decisions about a node:
// approve, revoke, forget. Each is an admin action under the gate, and
// each records who made it. Value imports are dynamic, like every other
// server module here — the repository reaches the database.

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
