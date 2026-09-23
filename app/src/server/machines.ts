import { createServerFn } from '@tanstack/react-start'

// The machine picker's list and a node's System page. Read-only, so no
// gate beyond the page's; value imports dynamic, like every server module.

const NODE_ID = /^[0-9a-f]{16}$/

/** Every approved node: what the pickers on System and Claude offer beside this box. */
export const fetchMachineNodesFn = createServerFn().handler(async () => {
  const { listNodes } = await import('../lib/repo/nodes')
  return (await listNodes()).filter((n) => n.state === 'approved')
})

export const fetchNodeSystemFn = createServerFn()
  .validator((data: unknown): { id: string } => {
    const id = (data as { id?: unknown } | null)?.id
    if (typeof id !== 'string' || !NODE_ID.test(id)) throw new Error('expected a node id')
    return { id }
  })
  .handler(async ({ data }) => {
    const { loadNodeSystem } = await import('../lib/dashboard/node-system')
    return loadNodeSystem(data.id)
  })

/** The strip above the box's own System tabs: its release, kernel and board. */
export const fetchBoxHeadFn = createServerFn().handler(async () => {
  const { loadBoxHead } = await import('../lib/dashboard/box-head')
  return loadBoxHead()
})
