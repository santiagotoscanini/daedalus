import type { Ctx } from '../ctx'

// Pocket ID's admin API, read-only: the clients, accounts, groups, settings
// and audit log behind the static API key.
//
// Core rather than a module's data because two pages need it and neither owns
// it. Home's Sign-in tab is the subject; the proxy's page borrows the client
// list to say which of its routes are gated, which is one column on a table
// about routing. Each assembles its own page from these — nothing here is
// shaped for a tab.
//
// core/settings/profile.ts talks to the same API and shares nothing with this
// file on purpose: it WRITES, so it needs the status of a refusal and the raw
// bytes of a picture, where every read here is a getJson that folds a failure
// into null.

/** What a reader here needs of the capability set — so a test hands it three fakes. */
export type IdentityCtx = Pick<Ctx, 'hosts' | 'secret' | 'http'>

/**
 * The id Pocket ID gives the principal behind STATIC_API_KEY: the all-zero
 * UUID, which is the only thing distinguishing it from a person — its username
 * is generated and its display name is whatever the release happened to call
 * it.
 */
export const STATIC_KEY_USER_ID = '00000000-0000-0000-0000-000000000000'

const base = (ctx: IdentityCtx) => ctx.hosts.base('pocket-id')
const auth = (ctx: IdentityCtx) => ({ headers: { 'X-API-KEY': ctx.secret('POCKETID_KEY') } })

export type PocketClient = {
  id?: string
  name?: string
  launchURL?: string
  callbackURLs?: string[]
  isGroupRestricted?: boolean
}

export async function idpClients(ctx: IdentityCtx): Promise<PocketClient[]> {
  const body = await ctx.http.getJson<{ data?: PocketClient[] }>(
    // 100 against a box that has 33: one page, and a second page would be a
    // second round trip to discover there was nothing on it.
    `${base(ctx)}/api/oidc/clients?pagination[limit]=100`,
    auth(ctx),
  )
  return body?.data ?? []
}

/**
 * Is this the registration the traefik forward-auth middleware signs in with.
 *
 * Matched on the callback, because that is the one thing the generator fixes:
 * `platform`'s publish layer emits exactly `https://<host>/oidc/callback` for
 * every `webApps.auth = "oidc"` entry, and an app's own login never uses that
 * path — it round-trips through whatever its framework mounts. Pocket ID's API
 * exposes no flag for this, so the URL is the tell.
 */
export function forwardAuthClient(c: PocketClient, host: string): boolean {
  const urls = c.callbackURLs ?? []
  return urls.length === 1 && urls[0] === `https://${host}/oidc/callback`
}

/** The hostname a client is for, from whichever URL it published. */
export function clientHost(c: PocketClient): string | null {
  const url = c.launchURL ?? c.callbackURLs?.[0] ?? ''
  try {
    return new URL(url).hostname
  } catch {
    // A native app's callback is a custom scheme (`app.immich:///oauth-callback`)
    // with no hostname at all. Not a fault — it just cannot name a route.
    return null
  }
}

export type AuditEvent = {
  id?: string
  createdAt?: string
  event?: string
  username?: string
  device?: string
  city?: string
  country?: string
  data?: { clientName?: string }
}

/**
 * The audit log, back as far as the window.
 *
 * Paged because Pocket ID caps a page at a hundred and this box logs a couple
 * of hundred a fortnight. Bounded at six pages rather than "until the window
 * is covered": an instance that suddenly logs thousands a day should slow this
 * page down by nothing, and a truncated count that says so is better than a
 * complete one that arrives late.
 */
export async function idpAuditLog(
  ctx: IdentityCtx,
  sinceMs: number,
): Promise<{ events: AuditEvent[]; truncated: boolean }> {
  const events: AuditEvent[] = []

  for (let page = 1; page <= 6; page++) {
    const body = await ctx.http.getJson<{
      data?: AuditEvent[]
      pagination?: { totalPages?: number }
    }>(
      `${base(ctx)}/api/audit-logs/all?pagination[limit]=100&pagination[page]=${String(page)}` +
        `&sort[column]=createdAt&sort[direction]=desc`,
      auth(ctx),
    )
    const rows = body?.data ?? []
    events.push(...rows)
    if (rows.length === 0) return { events, truncated: false }
    if (page >= (body?.pagination?.totalPages ?? page)) return { events, truncated: false }
    // The page we just read reaches past the window, so nothing older matters.
    const oldest = Date.parse(rows[rows.length - 1]?.createdAt ?? '')
    if (Number.isFinite(oldest) && oldest < sinceMs) return { events, truncated: false }
  }
  return { events, truncated: true }
}

export type PocketUser = {
  id?: string
  username?: string
  displayName?: string
  isAdmin?: boolean
  disabled?: boolean
  userGroups?: { name?: string; friendlyName?: string }[]
}

export type PocketGroup = { name?: string; friendlyName?: string; userCount?: number }

/** Every account, the static-API-key principal included — see `STATIC_KEY_USER_ID`. */
export async function idpUsers(ctx: IdentityCtx): Promise<PocketUser[]> {
  const body = await ctx.http.getJson<{ data?: PocketUser[] }>(
    `${base(ctx)}/api/users?pagination[limit]=100`,
    auth(ctx),
  )
  return body?.data ?? []
}

export async function idpGroups(ctx: IdentityCtx): Promise<PocketGroup[]> {
  const body = await ctx.http.getJson<{ data?: PocketGroup[] }>(
    `${base(ctx)}/api/user-groups?pagination[limit]=100`,
    auth(ctx),
  )
  return body?.data ?? []
}

/** The instance's own settings, as the key/value rows its admin page edits. */
export async function idpSettings(ctx: IdentityCtx): Promise<Map<string, string>> {
  const rows = await ctx.http.getJson<{ key?: string; value?: string }[]>(
    `${base(ctx)}/api/application-configuration`,
    auth(ctx),
  )
  const out = new Map<string, string>()
  for (const r of rows ?? [])
    if (r.key !== undefined && r.value !== undefined) out.set(r.key, r.value)
  return out
}
