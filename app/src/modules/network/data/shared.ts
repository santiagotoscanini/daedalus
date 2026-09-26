import type { Ctx } from '../../../core/ctx'
import { webAppHosts } from '../../../host/nix-manifest'
import { getJson, type JsonResult } from '../../../lib/http'

/* ── shared ───────────────────────────────────────────────────────────── */

/** How far back the per-day charts on Coming in, Going out and Proxy reach. */
export const DAYS = 14

/**
 * Pi-hole dialled directly rather than on its public hostname.
 *
 * The reads that use it (General's top lookups, DHCP's devices) carry
 * identities — which names the house looked up, which devices are on it, what
 * their MAC addresses are. On the public hostname they
 * would have to be added to the unauthenticated bypass that lets this app read
 * the aggregate counts, which would put the whole list one unauthenticated GET
 * away from anything on the LAN. Dialled directly there is nothing to widen.
 */
export const PIHOLE = (ctx: Ctx) => ctx.env('PIHOLE_URL') ?? 'http://host.containers.internal:8080'

/**
 * A session id for the blank password. `api.pwhash` is blank (the Pocket ID
 * gate is the real boundary, see nix/modules/pihole), and with it blank FTL
 * answers every read this module makes without a `sid` at all — dns-resolver.ts
 * sends none — so this handshake is a precaution, not a requirement. Lives
 * here rather than in lib/http.ts because pi-hole is this module's upstream
 * and nobody else's.
 */
export async function piholeSid(base: string): Promise<string | null> {
  const body = await getJson<{ session?: { sid: string | null } }>(`${base}/api/auth`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password: '' }),
  })
  return body?.session?.sid ?? null
}

export type CfTunnel = {
  status?: string
  connections?: {
    colo_name?: string
    origin_ip?: string
    opened_at?: string
    client_version?: string
  }[]
}

/** What Cloudflare's tunnel reads need of the token, as its token editor names it. */
export const CF_TUNNEL_READ = 'Account › Cloudflare One Connector: cloudflared › Read'

/**
 * Why a Cloudflare read came back empty, in words a person can act on; null
 * when it did not fail. A 401 or 403 is the token lacking `needs`, said out
 * loud because a refused read and an empty one otherwise look alike.
 */
export function cfReadError(ctx: Ctx, r: JsonResult<unknown>, needs: string): string | null {
  if (r.ok) return null
  if (ctx.secret('CF_API_TOKEN') === '') {
    return 'No Cloudflare API token in this container. See daedalus-dashboard-keys.'
  }
  const { status, error } = r.reason
  if (status === 401 || status === 403) return `Cloudflare refused the token: it needs ${needs}`
  if (status !== null) return `Cloudflare answered HTTP ${String(status)}`
  return error === 'malformed'
    ? 'Cloudflare answered with something that is not JSON'
    : 'Cloudflare did not answer'
}

export type TraefikRouter = {
  name?: string
  rule?: string
  status?: string
  provider?: string
  entryPoints?: string[]
  middlewares?: string[]
}

/**
 * Where pi-hole's own admin is, from the manifest.
 *
 * The hostname is a nix fact; guessing it produces a link that 404s. Callers
 * append paths from the site ROOT, not `/admin/`: this installation (the NixOS
 * service, not the Docker image the docs describe) answers 404 on `/admin/`
 * and 200 on `/settings-dhcp`.
 */
export async function piholeAdmin(): Promise<string | null> {
  const host = (await webAppHosts()).pihole
  return host === undefined ? null : `https://${host}`
}

/**
 * This box, as the LAN addresses it.
 *
 * Nearly every hosts entry points here, so the address is only worth printing
 * when it does NOT — and that comparison needs something to compare against.
 * Bound from `fleet.lanIp`, the same option that generates those entries, so
 * the two cannot drift apart into a page where every row looks interesting.
 */
export const lanIp = (ctx: Ctx) => ctx.env('LAN_IP') ?? ''
