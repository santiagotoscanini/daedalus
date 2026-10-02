import { swrValue } from '../../lib/cache'
import type { Ctx } from '../ctx'
import type {
  CloudflareStatus,
  InstallationStatus,
  IntegrationStatus,
  TokenCheck,
  VercelStatus,
} from './types'

// The live half of Settings › Integrations: each credential asked of the
// service that issued it. Split from the settings reader because these are
// network calls with someone else's rate limit behind them, so the page
// renders its facts first and these arrive deferred — and because a token
// that works is a different kind of fact from a token that is configured.
//
// Cached for five minutes: a settings page is opened and refreshed, and every
// refresh asking Cloudflare a question whose answer changes yearly would be
// waste for nothing.

const CF = 'https://api.cloudflare.com/client/v4'
const TTL_MS = 5 * 60_000

/** No token to ask about — which is what a null reason means here. */
const NOT_CONFIGURED = { ok: false, reason: null } as const

type CfVerify = {
  success?: boolean
  result?: { status?: string; expires_on?: string | null }
  errors?: { message?: string }[]
}

/**
 * `GET /user/tokens/verify` answers for the token that asks: its own status
 * and expiry. It says nothing about scope, which is why the zone and tunnel
 * reads below exist — the zone read proves Zone:Read on the domain, the tunnel
 * read proves the cloudflared connector permission, each by using it.
 */
async function verifyCloudflare(ctx: Ctx, token: string): Promise<TokenCheck> {
  if (token === '') return NOT_CONFIGURED
  const body = await ctx.http.getJson<CfVerify>(`${CF}/user/tokens/verify`, {
    headers: { Authorization: `Bearer ${token}` },
  })
  if (body === null) {
    return { ok: false, reason: 'Cloudflare rejected the token, or did not answer' }
  }
  const status = body.result?.status ?? null
  if (body.success !== true) {
    return { ok: false, reason: body.errors?.[0]?.message ?? 'verification failed' }
  }
  // Verified, but not active: Cloudflare's own word for the state (`expired`,
  // `disabled`) is the whole reason, and it says it without an error.
  if (status !== 'active') return { ok: false, reason: status }
  return { ok: true, value: { status, expiresOn: body.result?.expires_on ?? null } }
}

async function cloudflare(ctx: Ctx): Promise<CloudflareStatus> {
  // One token for everything Cloudflare on the box; see core/settings/zones.ts.
  const token = ctx.secret('CF_API_TOKEN')
  const zoneId = ctx.env('CF_ZONE_ID') ?? ''
  const accountId = ctx.env('CF_ACCOUNT_ID') ?? ''
  const tunnelId = ctx.env('CF_TUNNEL_ID') ?? ''
  const auth = { headers: { Authorization: `Bearer ${token}` } }

  const [check, zone, tunnel] = await Promise.all([
    verifyCloudflare(ctx, token),
    token === '' || zoneId === ''
      ? null
      : ctx.http.getJson<{ result?: { name?: string; status?: string } }>(
          `${CF}/zones/${zoneId}`,
          auth,
        ),
    token === '' || accountId === '' || tunnelId === ''
      ? null
      : ctx.http.getJson<{ result?: { name?: string; status?: string } }>(
          `${CF}/accounts/${accountId}/cfd_tunnel/${tunnelId}`,
          auth,
        ),
  ])

  return {
    token: check,
    zone:
      zone?.result?.name === undefined
        ? null
        : { name: zone.result.name, status: zone.result.status ?? '' },
    tunnel:
      tunnel?.result?.name === undefined
        ? null
        : { name: tunnel.result.name, status: tunnel.result.status ?? '' },
  }
}

/**
 * The relay's last successful send, from its own journal line. Anchored at
 * the start of the line: anything that merely QUOTES an msmtp line — a
 * remote-control transcript, this very code in a log — starts with something
 * else and does not match.
 */
async function mail(ctx: Ctx): Promise<IntegrationStatus['mail']> {
  const entries = await ctx.loki.entries(
    '{stack="system"} |~ "^host=[^ ]+ tls=on .*smtpstatus=250"',
    60 * 24 * 30,
    1,
  )
  const last = entries[0]
  if (last === undefined) return { lastSentAt: null, lastRecipient: null }
  return {
    lastSentAt: new Date(last.at).toISOString(),
    lastRecipient: /recipients=(\S+)/.exec(last.line)?.[1] ?? null,
  }
}

/**
 * The Vercel token, asked of Vercel: who it is, which scopes it reaches,
 * and when it expires (`/v5/user/tokens/current`, the token describing
 * itself). The off-box list reads every scope this names.
 */
async function vercel(ctx: Ctx): Promise<VercelStatus> {
  if (ctx.secret('VERCEL_API_TOKEN') === '')
    return { token: NOT_CONFIGURED, user: null, scopes: [] }
  const { vercelScopes, vercelTokenExpiry } = await import('../offbox/vercel')
  const [who, expiry] = await Promise.all([vercelScopes(ctx), vercelTokenExpiry(ctx)])
  if (!who.ok) return { token: { ok: false, reason: who.reason }, user: null, scopes: [] }
  return {
    token: { ok: true, value: { status: 'active', expiresOn: expiry } },
    user: who.user,
    scopes: who.scopes.map((s) => s.slug),
  }
}

/**
 * Every installation of the GitHub App, from the files the host's minter
 * publishes: the owner's, which builds, and any other account or org, which
 * only reads. `missing` is what the box asks for that GitHub has not been told
 * to grant — the operator's step, named on the page.
 */
async function installations(ctx: Ctx): Promise<InstallationStatus[]> {
  const { installationState, otherInstallations } = await import('../github-app')
  const [owner, others] = await Promise.all([installationState(ctx), otherInstallations(ctx)])
  const out: InstallationStatus[] = []
  if (owner.available && owner.data.account !== null) {
    out.push({
      account: owner.data.account.login,
      owner: true,
      selection: owner.data.repositorySelection,
      ok: owner.data.state === 'ok',
      reason: owner.data.reason,
      missing: owner.data.missingPermissions,
    })
  }
  for (const i of others.data) {
    out.push({
      account: i.account?.login ?? String(i.installationId),
      owner: false,
      selection: i.repositorySelection,
      ok: i.state === 'ok',
      reason: i.reason,
      missing: i.missingPermissions,
    })
  }
  return out
}

/**
 * A check that failed outright reads as "did not answer", never as a broken
 * tab. These promises stream into an <Await>, and a rejection there is a
 * render error for the whole page — one failing upstream must not cost the
 * operator the other answers.
 */
async function settled<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work
  } catch {
    return fallback
  }
}

/**
 * The check itself threw. There is nothing to say about a token that is not
 * there, so an absent one stays NOT_CONFIGURED rather than reporting a
 * failure nobody caused.
 */
const CHECK_FAILED = 'the check failed; it is asked again within five minutes'

const failedCheck = (token: string): { ok: false; reason: string | null } =>
  token === '' ? NOT_CONFIGURED : { ok: false, reason: CHECK_FAILED }

async function load(ctx: Ctx): Promise<IntegrationStatus> {
  const cfToken = ctx.secret('CF_API_TOKEN')
  const vercelToken = ctx.secret('VERCEL_API_TOKEN')
  const [cf, m, v, inst] = await Promise.all([
    settled(cloudflare(ctx), { token: failedCheck(cfToken), zone: null, tunnel: null }),
    settled(mail(ctx), { lastSentAt: null, lastRecipient: null }),
    settled(vercel(ctx), { token: failedCheck(vercelToken), user: null, scopes: [] }),
    settled(installations(ctx), []),
  ])
  return {
    checkedAt: new Date().toISOString(),
    cloudflare: cf,
    mail: m,
    vercel: v,
    installations: inst,
  }
}

let cached: (() => Promise<IntegrationStatus>) | null = null

export function integrationStatus(ctx: Ctx): Promise<IntegrationStatus> {
  cached ??= swrValue({ ttlMs: TTL_MS }, () => load(ctx))
  return cached()
}
