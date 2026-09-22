import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import { actorLabel } from '../core/auth'
import type { SiteEdit, SiteField, SiteState } from '../core/site'
import type { SiteRequestStatus } from '../host/site-request'
import type { Site } from '../lib/site'

// Server functions behind Settings › Site: the directory's state against what
// this box would write, the commit switch, and the one action that writes.
//
// The state is deferred and fetched only for the tab that shows it: it
// renders site.json to hash it, which the page's other five tabs do not need.
//
// Value imports are dynamic — the core modules reach for node:fs and the
// database, and nothing here may be pulled into a client bundle.

/**
 * The box's identity, for the browser. The root loader awaits it, so it is in
 * the server-rendered HTML and `useSite()` never renders a placeholder first.
 */
export const fetchSite = createServerFn().handler(async (): Promise<Site> => {
  const { readSite } = await import('../host/site')
  return readSite()
})

export const fetchSiteState = createServerFn().handler(async (): Promise<SiteState> => {
  const { makeCtx } = await import('../core/ctx')
  const { siteState } = await import('../core/site')
  return siteState(await makeCtx())
})

export const fetchSiteRequestStatus = createServerFn().handler(
  async (): Promise<SiteRequestStatus> => {
    const { readSiteRequestStatus } = await import('../host/site-request')
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
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { writeSiteCommit } = await import('../core/site')
    await writeSiteCommit(await makeCtx(), data)
    return data
  })

export const writeSiteFiles = createServerFn({ method: 'POST' }).handler(async () => {
  const { assertAdmin } = await import('../core/authz')
  await assertAdmin()
  const { makeCtx } = await import('../core/ctx')
  const { writeSite } = await import('../core/site')
  // The forward-auth middleware forwards the Pocket ID claim, so the commit
  // records a person rather than "daedalus".
  const actor = actorLabel()
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
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { saveSiteEdit } = await import('../core/site')
    // The address this request reached the box at — traefik passes the Host
    // through. Retiring the control plane's old address is only accepted from
    // the new one (core/site refuseUnknown).
    const raw = getRequestHeader('x-forwarded-host') ?? getRequestHeader('host') ?? ''
    const requestHost = raw.split(',')[0]?.trim().replace(/:\d+$/, '') || null
    return saveSiteEdit(await makeCtx(), data, { requestHost })
  })

/**
 * The engine override as the COMMITTED site.json holds it — the value the
 * host agents read — or null. For the banner the shell draws on every page:
 * the root loader awaits it, so it is in the server's HTML like the theme. A
 * pending edit is not an override yet; the Developer tab shows that one.
 */
export const fetchEngineOverride = createServerFn().handler(async (): Promise<string | null> => {
  const { readCommittedSite } = await import('../host/contract/domains/site-doc')
  const site = await readCommittedSite()
  return site.ok ? site.value.doc.developer.engineOverride : null
})
