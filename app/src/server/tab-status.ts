import { asValidator, obj, withMessage } from '../lib/contract/decode'
import { moduleIdField } from '../lib/contract/fields'
import { moduleById } from '../lib/modules/registry'
import { readFn } from './fn'

// The dots on a module page's sub-tab row.
//
// Its own server function rather than a field on the boards payload, because
// the tab row is the one part of a module page that renders before anything
// is fetched: the boards fan out across a dozen services and the dots are a
// few prometheus queries. Hanging the dots off the boards would hold the whole row
// hostage to the slowest upstream on the page, in order to draw a circle.
// The computation is host/tab-status.ts, shared with the rail's roll-up.

export type { TabStatus } from '../host/tab-status'

export const fetchTabStatus = readFn
  .validator(asValidator(withMessage(obj({ module: moduleIdField }), 'expected a module')))
  .handler(async ({ data, context }) => {
    const spec = moduleById(data.module)
    if (spec === undefined) return {}
    const { tabStatuses } = await import('../host/tab-status')
    const { prom } = await context.ctx()
    return (await tabStatuses(prom, [spec]))[spec.id] ?? {}
  })
