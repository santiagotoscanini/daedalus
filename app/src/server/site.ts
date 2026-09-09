import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import type { SiteState } from '../core/site'
import type { SiteRequestStatus } from '../lib/site-request'

// Server functions behind Settings › Site: the directory's state against what
// this box would write, the commit switch, and the one action that writes.
//
// The state is deferred and fetched only for the tab that shows it: it
// renders site.json to hash it, which the page's other five tabs do not need.
//
// Value imports are dynamic — the core modules reach for node:fs and the
// database, and nothing here may be pulled into a client bundle.

export const fetchSiteState = createServerFn().handler(async (): Promise<SiteState> => {
  const { makeCtx } = await import('../core/ctx')
  const { siteState } = await import('../core/site')
  return siteState(await makeCtx())
})

export const fetchSiteRequestStatus = createServerFn().handler(
  async (): Promise<SiteRequestStatus> => {
    const { readSiteRequestStatus } = await import('../lib/site-request')
    return readSiteRequestStatus()
  },
)

/** Whether the host commits after every write. Staging is never optional. */
export const setSiteCommit = createServerFn({ method: 'POST' })
  .validator((data: unknown): boolean => {
    if (typeof data !== 'boolean') throw new Error('expected a boolean')
    return data
  })
  .handler(async ({ data }) => {
    const { makeCtx } = await import('../core/ctx')
    const { writeSiteCommit } = await import('../core/site')
    await writeSiteCommit(await makeCtx(), data)
    return data
  })

export const writeSiteFiles = createServerFn({ method: 'POST' }).handler(async () => {
  const { makeCtx } = await import('../core/ctx')
  const { writeSite } = await import('../core/site')
  // The forward-auth middleware forwards the Pocket ID claim, so the commit
  // records a person rather than "daedalus".
  const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'
  return writeSite(await makeCtx(), actor)
})
