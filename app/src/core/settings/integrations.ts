import { swrValue } from '../../lib/cache'
import { githubTokenKind } from '../../lib/github-token'
import { ATTEMPT_MS } from '../../lib/http'
import type { Ctx } from '../ctx'
import type { CloudflareStatus, GithubCheck, IntegrationStatus, TokenCheck } from './types'

// The live half of Settings › Integrations: each credential asked of the
// service that issued it. Split from the settings reader because these are
// network calls with someone else's rate limit behind them, so the page
// renders its facts first and these arrive deferred — and because a token
// that works is a different kind of fact from a token that is configured.
//
// Cached for five minutes. A settings page is opened and refreshed, and every
// refresh spending GitHub's per-token budget (5,000/h authenticated) on a
// question whose answer changes yearly would be waste for nothing.

const CF = 'https://api.cloudflare.com/client/v4'
const TTL_MS = 5 * 60_000

const NOT_CONFIGURED: TokenCheck = {
  configured: false,
  ok: false,
  status: null,
  expiresOn: null,
  error: null,
}

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
    return {
      configured: true,
      ok: false,
      status: null,
      expiresOn: null,
      error: 'Cloudflare rejected the token, or did not answer',
    }
  }
  const status = body.result?.status ?? null
  return {
    configured: true,
    ok: body.success === true && status === 'active',
    status,
    expiresOn: body.result?.expires_on ?? null,
    error: body.success === true ? null : (body.errors?.[0]?.message ?? 'verification failed'),
  }
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

function rateLimitOf(h: Headers): GithubCheck['rateLimit'] {
  const remaining = Number(h.get('x-ratelimit-remaining'))
  const limit = Number(h.get('x-ratelimit-limit'))
  const reset = Number(h.get('x-ratelimit-reset'))
  if (!Number.isFinite(remaining) || !Number.isFinite(limit) || limit === 0) return null
  return {
    remaining,
    limit,
    resetAt: Number.isFinite(reset) && reset > 0 ? new Date(reset * 1000).toISOString() : '',
  }
}

/**
 * `GET /user` with the token: who it is, and — from the response headers —
 * what it may do and how much of its hour is left. Hand-rolled fetch rather
 * than getJson because the headers ARE the answer here.
 *
 * Retried on the same ladder as every other first connection off the
 * bridge, and only when the request throws: a 401 is GitHub answering, and
 * asking again would not change its mind.
 */
async function checkGithub(token: string): Promise<GithubCheck> {
  const none: GithubCheck = {
    configured: false,
    ok: false,
    login: null,
    kind: 'unknown',
    scopes: [],
    rateLimit: null,
    error: null,
  }
  if (token === '') return none
  // Provisional, from the prefix; settled by the response below. A classic
  // token minted before GitHub prefixed them is forty hex characters and
  // says nothing about itself — but only a classic token gets an
  // X-OAuth-Scopes header back, so the answer is in the reply.
  let kind: GithubCheck['kind'] = githubTokenKind(token)

  for (const ms of ATTEMPT_MS) {
    let res: Response
    let body: { login?: string } = {}
    try {
      res = await fetch('https://api.github.com/user', {
        headers: { Accept: 'application/vnd.github+json', Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(ms),
      })
      // The body is read INSIDE the attempt: the timeout covers it too, and a
      // body cut off by it used to throw outside this try — rejecting every
      // integration check at once and taking Settings › Integrations down with
      // it, on the first visit after a container restart.
      if (res.ok) body = (await res.json()) as { login?: string }
    } catch {
      continue
    }
    const rateLimit = rateLimitOf(res.headers)
    if (!res.ok) {
      return {
        ...none,
        configured: true,
        kind,
        rateLimit,
        error:
          res.status === 401
            ? 'GitHub rejected the token (401): expired or revoked'
            : `GitHub answered ${String(res.status)}`,
      }
    }
    const scopeHeader = res.headers.get('x-oauth-scopes')
    const scopes = (scopeHeader ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== '')
    if (kind === 'unknown') kind = scopeHeader === null ? 'fine-grained' : 'classic'
    return {
      configured: true,
      ok: true,
      login: body.login ?? null,
      kind,
      scopes,
      rateLimit,
      error: null,
    }
  }
  return { ...none, configured: true, kind, error: 'GitHub did not answer' }
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
 * A check that failed outright reads as "did not answer", never as a broken
 * tab. These promises stream into an <Await>, and a rejection there is a
 * render error for the whole page — one slow upstream must not cost the
 * operator the other three answers.
 */
async function settled<T>(work: Promise<T>, fallback: T): Promise<T> {
  try {
    return await work
  } catch {
    return fallback
  }
}

function failedToken(configured: boolean, error: string): TokenCheck {
  return { configured, ok: false, status: null, expiresOn: null, error: configured ? error : null }
}

function failedGithub(token: string): GithubCheck {
  return {
    configured: token !== '',
    ok: false,
    login: null,
    kind: 'unknown',
    scopes: [],
    rateLimit: null,
    error: token === '' ? null : 'the check failed; it is asked again within five minutes',
  }
}

async function load(ctx: Ctx): Promise<IntegrationStatus> {
  const cfToken = ctx.secret('CF_API_TOKEN')
  const ghRepoToken = ctx.secret('GITHUB_REPO_TOKEN')
  const [cf, repoToken, m] = await Promise.all([
    settled(cloudflare(ctx), {
      token: failedToken(cfToken !== '', 'the check failed; it is asked again within five minutes'),
      zone: null,
      tunnel: null,
    }),
    settled(checkGithub(ghRepoToken), failedGithub(ghRepoToken)),
    settled(mail(ctx), { lastSentAt: null, lastRecipient: null }),
  ])
  return {
    checkedAt: new Date().toISOString(),
    cloudflare: cf,
    github: { repoToken },
    mail: m,
  }
}

let cached: (() => Promise<IntegrationStatus>) | null = null

export function integrationStatus(ctx: Ctx): Promise<IntegrationStatus> {
  cached ??= swrValue({ ttlMs: TTL_MS }, () => load(ctx))
  return cached()
}
