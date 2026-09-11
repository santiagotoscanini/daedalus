import { getJson, type JsonResult } from '../../../http'
import { key } from '../../../keys'
import { webAppHosts } from '../../../nix-manifest'

/* ── shared ───────────────────────────────────────────────────────────── */

/** How far back the two VPN tabs chart. A column per day, same as the AI tabs. */
export const DAYS = 14

/**
 * Pi-hole off the bridge rather than on its public hostname.
 *
 * Both reads below carry identities — which names the house looked up, which
 * devices are on it, what their MAC addresses are. On the public hostname they
 * would have to be added to the unauthenticated bypass that lets this app read
 * the aggregate counts, which would put the whole list one unauthenticated GET
 * away from anything on the LAN. Dialled directly there is nothing to widen.
 */
export const PIHOLE = () => process.env.PIHOLE_URL ?? 'http://host.containers.internal:8080'

/**
 * Pi-hole v6 hands out a session id even with no password set (`api.pwhash`
 * is blank — the Pocket ID gate is the real boundary, see stacks/pihole), but
 * the stats endpoints still want the `sid` header. Lives here rather than in
 * lib/http.ts because pi-hole is this tab's upstream and nobody else's.
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
 * when it did not fail. A 401 or 403 is the token lacking `needs` — the case
 * that used to render as a quiet dash, because a refused read and an empty one
 * looked exactly alike.
 */
export function cfReadError(r: JsonResult<unknown>, needs: string): string | null {
  if (r.ok) return null
  if (key('CF_API_TOKEN') === '') {
    return 'No Cloudflare API token in this container. See daedalus-dashboard-keys.'
  }
  if (r.status === 401 || r.status === 403) return `Cloudflare refused the token: it needs ${needs}`
  return r.status === null
    ? 'Cloudflare did not answer'
    : `Cloudflare answered HTTP ${String(r.status)}`
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
 * The hostname is a nix fact and guessing it produces a link that 404s, which
 * is exactly what the hand-written one here used to do — for a second reason
 * as well: this installation serves the interface from the site ROOT, not from
 * `/admin/`. `/admin/` answers 404 and `/settings-dhcp` answers 200, so the
 * paths below are the verified ones rather than the ones the docs describe for
 * the Docker image.
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
export const LAN_IP = process.env.LAN_IP ?? ''
