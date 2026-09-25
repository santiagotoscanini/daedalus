import { createServerFn } from '@tanstack/react-start'
import { actorLabel } from '../core/auth'
import { isRecord } from '../lib/is-record'

// The server functions behind a stack's version-update button
// (host/version-update.ts). Returns once the request is published; the host
// reports everything after that through the status file the page polls.

export const fetchVersionUpdateStatus = createServerFn().handler(async () => {
  const { readVersionUpdateStatus } = await import('../host/version-update')
  return readVersionUpdateStatus()
})

export const requestVersionUpdateFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { target: string; values: Record<string, string> } => {
    if (!isRecord(data) || typeof data.target !== 'string' || !isRecord(data.values)) {
      throw new Error('expected { target, values }')
    }
    const values: Record<string, string> = {}
    for (const [k, v] of Object.entries(data.values)) {
      if (typeof v !== 'string') throw new Error(`${k} must be a string`)
      values[k] = v
    }
    return { target: data.target, values }
  })
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { runVersionUpdate } = await import('../host/version-update')
    return runVersionUpdate({ ...data, actor: actorLabel() })
  })
