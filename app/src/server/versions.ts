import { asValidator, obj, str, withMessage } from '../lib/contract/decode'
import { stringMapField } from '../lib/contract/fields'
import { adminFn, readFn } from './fn'

// The server functions behind a stack's version-update button
// (host/version-update.ts). Returns once the host's update has started; it
// reports everything after that through the status file the page polls.

export const fetchVersionUpdateStatus = readFn.handler(async ({ context }) => {
  const { readVersionUpdateStatus } = await import('../host/version-update')
  return readVersionUpdateStatus(await context.ctx())
})

export const requestVersionUpdateFn = adminFn
  .validator(
    asValidator(
      withMessage(obj({ target: str, values: stringMapField }), 'expected { target, values }'),
    ),
  )
  .handler(async ({ data, context }) => {
    const { runVersionUpdate } = await import('../host/version-update')
    return runVersionUpdate({ ...data, ctx: await context.ctx(), actor: context.actor })
  })
