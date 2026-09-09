import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import type { SiteMirror } from '../core/site'
import type { SiteRequestStatus } from '../lib/site-request'

// Server functions behind Settings › Site repository: what the repository
// holds against what this box would write, and the one action that changes
// it.
//
// Deferred rather than part of fetchBoxSettings, and only for the tab that
// shows it: the comparison reads and hashes every managed file, which the
// page's other five tabs have no use for.
//
// Value imports are dynamic — the core modules reach for node:fs and the
// database, and nothing here may be pulled into a client bundle.

export const fetchSiteMirror = createServerFn().handler(async (): Promise<SiteMirror> => {
  const { makeCtx } = await import('../core/ctx')
  const { siteMirror } = await import('../core/site')
  return siteMirror(await makeCtx())
})

export const fetchSiteRequestStatus = createServerFn().handler(
  async (): Promise<SiteRequestStatus> => {
    const { readSiteRequestStatus } = await import('../lib/site-request')
    return readSiteRequestStatus()
  },
)

/**
 * Create or adopt the site repository and commit the current render into it.
 *
 * `remote` is validated for SHAPE only. Whether the repository exists, whether
 * the token may write to it, and whether creating it is allowed are all
 * questions only GitHub can answer, and the host agent asks it — a check here
 * would be a guess this container is in no position to make.
 */
export const initSiteRepo = createServerFn({ method: 'POST' })
  .validator((data: unknown): { remote: string; createRemote: boolean } => {
    const d = data as { remote?: unknown; createRemote?: unknown }
    const remote = typeof d.remote === 'string' ? d.remote.trim() : ''
    // `owner/name`, or nothing at all. A URL is deliberately not accepted:
    // the host builds the URL from the pieces, so the transport (and the
    // credential that goes with it) stays the host's decision.
    if (remote !== '' && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(remote)) {
      throw new Error('a remote must be written owner/name')
    }
    const createRemote = d.createRemote === true
    if (createRemote && remote === '') throw new Error('nothing to create without a remote')
    return { remote, createRemote }
  })
  .handler(async ({ data }) => {
    const { makeCtx } = await import('../core/ctx')
    const { initSite } = await import('../core/site')
    const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'
    return initSite(await makeCtx(), { ...data, actor })
  })
