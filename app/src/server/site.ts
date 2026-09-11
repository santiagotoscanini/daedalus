import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import type { SiteEdit, SiteField, SiteState } from '../core/site'
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

/** Committed, desired and the difference — the editable tabs render from this. */
export const fetchSiteEdit = createServerFn().handler(async (): Promise<SiteEdit> => {
  const { makeCtx } = await import('../core/ctx')
  const { siteEdit } = await import('../core/site')
  return siteEdit(await makeCtx())
})

/**
 * Record an edit to the desired document. Validated as a WHOLE document by
 * the decoder (core/site), so a value of the wrong type is refused rather
 * than stored; the field list is closed — only what nix sources from
 * site.json may be edited here.
 */
export const saveSiteEditFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): Partial<Record<SiteField, unknown>> => {
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('expected a patch object')
    }
    return data as Partial<Record<SiteField, unknown>>
  })
  .handler(async ({ data }): Promise<SiteEdit> => {
    const { makeCtx } = await import('../core/ctx')
    const { saveSiteEdit } = await import('../core/site')
    // The address this request reached the box at — traefik passes the Host
    // through. Retiring the control plane's old address is only accepted from
    // the new one (core/site refuseUnknown).
    const raw = getRequestHeader('x-forwarded-host') ?? getRequestHeader('host') ?? ''
    const requestHost = raw.split(',')[0]?.trim().replace(/:\d+$/, '') || null
    return saveSiteEdit(await makeCtx(), data, { requestHost })
  })
