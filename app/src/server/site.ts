import { getRequestHeader } from '@tanstack/react-start/server'
import type { SiteEdit, SiteField, SiteState } from '../core/site'
import type { SiteRequestStatus } from '../host/site-request'
import { asValidator, bool, is, withMessage } from '../lib/contract/decode'
import { isRecord } from '../lib/is-record'
import type { Site } from '../lib/site'
import { adminFn, readFn } from './fn'

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
export const fetchSite = readFn.handler(async (): Promise<Site> => {
  const { readSite } = await import('../host/site')
  return readSite()
})

export const fetchSiteState = readFn.handler(async ({ context }): Promise<SiteState> => {
  const { siteState } = await import('../core/site')
  return siteState(await context.ctx())
})

export const fetchSiteRequestStatus = readFn.handler(async (): Promise<SiteRequestStatus> => {
  const { readSiteRequestStatus } = await import('../host/site-request')
  return readSiteRequestStatus()
})

/** Whether the host commits after every write. Staging is never optional. */
export const setSiteCommit = adminFn
  .validator(asValidator(withMessage(bool, 'expected a boolean')))
  .handler(async ({ data, context }) => {
    const { writeSiteCommit } = await import('../core/site')
    await writeSiteCommit(await context.ctx(), data)
    return data
  })

export const writeSiteFiles = adminFn.handler(async ({ context }) => {
  const { writeSite } = await import('../core/site')
  return writeSite(await context.ctx(), context.actor())
})

/** Committed, desired and the difference — the editable tabs render from this. */
export const fetchSiteEdit = readFn.handler(async ({ context }): Promise<SiteEdit> => {
  const { siteEdit } = await import('../core/site')
  return siteEdit(await context.ctx())
})

/**
 * Any plain object, passed through as it arrived: the patch is decoded as a
 * WHOLE document by core/site, not field by field here.
 */
const sitePatch = withMessage(
  is((v: unknown): v is Partial<Record<SiteField, unknown>> => isRecord(v), 'a patch object'),
  'expected a patch object',
)

/**
 * Record an edit to the desired document. Validated as a WHOLE document by
 * the decoder (core/site), so a value of the wrong type is refused rather
 * than stored; the field list is closed — only what nix sources from
 * site.json may be edited here.
 */
export const saveSiteEditFn = adminFn
  .validator(asValidator(sitePatch))
  .handler(async ({ data, context }): Promise<SiteEdit> => {
    const { saveSiteEdit } = await import('../core/site')
    // The address this request reached the box at — traefik passes the Host
    // through. Retiring the control plane's old address is only accepted from
    // the new one (core/site refuseUnknown).
    const raw = getRequestHeader('x-forwarded-host') ?? getRequestHeader('host') ?? ''
    const requestHost = raw.split(',')[0]?.trim().replace(/:\d+$/, '') || null
    return saveSiteEdit(await context.ctx(), data, { requestHost })
  })

/**
 * The engine override as the COMMITTED site.json holds it — the value the
 * host agents read — or null. For the banner the shell draws on every page:
 * the root loader awaits it, so it is in the server's HTML like the theme. A
 * pending edit is not an override yet; the Developer tab shows that one.
 */
export const fetchEngineOverride = readFn.handler(async (): Promise<string | null> => {
  const { readCommittedSite } = await import('../host/contract/domains/site-doc')
  const site = await readCommittedSite()
  return site.ok ? site.value.doc.developer.engineOverride : null
})
