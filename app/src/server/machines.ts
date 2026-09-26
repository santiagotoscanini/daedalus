import { asValidator, obj, withMessage } from '../lib/contract/decode'
import { flagField, nodeIdField } from '../lib/contract/fields'
import { readFn } from './fn'

// The machine picker's list and a node's System page. Read-only, so no
// gate beyond the page's; value imports dynamic, like every server module.

/** Every approved node: what the pickers on System and Claude offer beside this box. */
export const fetchMachineNodesFn = readFn.handler(async () => {
  const { listNodes } = await import('../lib/repo/nodes')
  return (await listNodes()).filter((n) => n.state === 'approved')
})

export const fetchNodeSystemFn = readFn
  .validator(
    asValidator(
      withMessage(
        obj({ id: nodeIdField, board: flagField, browsers: flagField, macos: flagField }),
        'expected a node id',
      ),
    ),
  )
  .handler(async ({ data }) => {
    const { loadNodeSystem } = await import('../lib/dashboard/node-system')
    return loadNodeSystem(data.id, {
      board: data.board,
      browsers: data.browsers,
      macos: data.macos,
    })
  })

/** The strip above the box's own System tabs: its release, kernel and board. */
export const fetchBoxHeadFn = readFn.handler(async () => {
  const { loadBoxHead } = await import('../lib/dashboard/box-head')
  return loadBoxHead()
})
