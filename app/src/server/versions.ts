import { asValidator, obj, str, withMessage } from '../lib/contract/decode'
import { stringMapField } from '../lib/contract/fields-a'
import { adminFn, readFn } from './fn'

// The server functions behind a stack's version-update button
// (host/version-update.ts). Returns once the request is published; the host
// reports everything after that through the status file the page polls.

export const fetchVersionUpdateStatus = readFn.handler(async () => {
  const { readVersionUpdateStatus } = await import('../host/version-update')
  return readVersionUpdateStatus()
})

export const requestVersionUpdateFn = adminFn
  .validator(
    asValidator(
      withMessage(obj({ target: str, values: stringMapField }), 'expected { target, values }'),
    ),
  )
  .handler(async ({ data, context }) => {
    const { runVersionUpdate } = await import('../host/version-update')
    return runVersionUpdate({ ...data, actor: context.actor() })
  })
