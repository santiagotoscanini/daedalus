import { swrValue } from '../../lib/cache'
import type { Ctx } from '../ctx'
import type { CloudflareZone, ZoneList } from './types'

// The Cloudflare zones the DNS token can see: what Settings › General offers as
// the domain, and what a save of the domain is checked against.
//
// The DNS token and not the API token, because the DNS token is what traefik's
// ACME challenge and the tunnel's record reconciler use. A zone it cannot see
// is a domain this box could not get a certificate for, so it is not offered.
// Listing is not proof of edit rights, but a token scoped to a zone lists that
// zone and nothing else, which makes the list the right filter without asking
// Cloudflare about permissions zone by zone.
//
// Cached five minutes with stale answers served through a failure, like the
// integration checks. The list only changes when somebody widens the token.

const CF = 'https://api.cloudflare.com/client/v4'

type ZonesBody = {
  success?: boolean
  result?: { id?: string; name?: string; status?: string }[]
}

async function load(ctx: Ctx): Promise<CloudflareZone[] | null> {
  const body = await ctx.http.getJson<ZonesBody>(`${CF}/zones?per_page=50`, {
    headers: { Authorization: `Bearer ${ctx.secret('CF_DNS_TOKEN')}` },
  })
  if (body === null || body.success !== true) return null
  return (body.result ?? [])
    .flatMap((z): CloudflareZone[] =>
      z.id === undefined || z.name === undefined
        ? []
        : [{ id: z.id, name: z.name, status: z.status ?? '' }],
    )
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

let cached: (() => Promise<CloudflareZone[] | null>) | null = null

export async function listZones(ctx: Ctx): Promise<ZoneList> {
  if (ctx.secret('CF_DNS_TOKEN') === '') {
    return { ok: false, reason: 'no Cloudflare DNS token is configured' }
  }
  cached ??= swrValue({ ttlMs: 5 * 60_000, retryMs: 30_000 }, () => load(ctx))
  const zones = await cached()
  return zones === null
    ? { ok: false, reason: 'Cloudflare did not answer, or refused the DNS token' }
    : { ok: true, zones }
}
