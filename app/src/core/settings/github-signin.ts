import { randomUUID } from 'node:crypto'
import {
  type DeviceStep,
  type DeviceTokenReply,
  GITHUB_SCOPES,
  GITHUB_TOKEN_FILE,
  GITHUB_TOKEN_SECRET,
  missingScopes,
  oauthClientId,
  readDeviceReply,
  type SignInPoll,
  type SignInStart,
} from '../../lib/github-signin'
import { getJsonResult } from '../../lib/http'
import { OWNER } from '../../lib/site'
import type { Ctx } from '../ctx'
import { sealForVault } from '../vault'

// Settings › Integrations › GitHub › Sign in — Phase 7: the box's GitHub
// token comes from GitHub's own consent screen instead of a pasted classic PAT.
//
// The OAuth device flow, because it needs no callback URL and no client
// secret: the page asks for a code, a person enters it on github.com while
// signed in as the account, and this server polls until GitHub hands the
// token over. Only that short user code reaches the browser. The device code
// that redeems it stays here, under an opaque flow id, and the token never
// leaves this process except as ciphertext.
//
// Before anything changes, the token is checked for what the box does with
// it: it belongs to the account the app repositories live under, it carries
// `repo`, and it can read a repository's self-hosted runners (repository
// admin — the most demanding read, and the runners' whole job). Only then is
// it sealed for site/vault/ (core/vault.ts) and applied as its own change,
// like the Cloudflare token. Nix moves the consumers to it once
// fleet.github.tokenFromSite is on (s2-server platform/git).

const API = 'https://api.github.com'

/**
 * One patient attempt for GitHub's two POSTs, never the retry ladder: a poll
 * retried after a slow reply can find the device code already redeemed, and
 * the token that first reply carried is then lost.
 */
const ONCE = [8_000]

const FORM = {
  Accept: 'application/json',
  'Content-Type': 'application/x-www-form-urlencoded',
}

type Flow = {
  deviceCode: string
  clientId: string
  expiresAt: number
  /** Seconds; grows on every slow_down and never shrinks. */
  interval: number
  nextPollAt: number
  busy: boolean
}

// On globalThis for the reason lib/db.ts memoises there: `vite dev`
// re-evaluates modules on save, and a save must not strand a sign-in that is
// waiting on a person.
const store = globalThis as unknown as { daedalusGithubFlows?: Map<string, Flow> }
const flows = store.daedalusGithubFlows ?? new Map<string, Flow>()
store.daedalusGithubFlows = flows

function sweep(now: number) {
  for (const [id, f] of flows) if (f.expiresAt <= now) flows.delete(id)
}

type DeviceCodeReply = {
  device_code?: string
  user_code?: string
  verification_uri?: string
  expires_in?: number
  interval?: number
  error?: string
}

export async function startGithubSignIn(ctx: Ctx): Promise<SignInStart> {
  const clientId = oauthClientId(ctx.env('GITHUB_OAUTH_CLIENT_ID'))
  if (clientId === '') return { ok: false, reason: 'No OAuth App is configured for sign-in.' }

  const { secretApplyBlocker } = await import('../../lib/apply-flow')
  const blocked = await secretApplyBlocker()
  if (blocked !== null) return { ok: false, reason: blocked }

  const res = await getJsonResult<DeviceCodeReply>(
    'https://github.com/login/device/code',
    {
      method: 'POST',
      headers: FORM,
      body: new URLSearchParams({ client_id: clientId, scope: GITHUB_SCOPES.join(' ') }).toString(),
    },
    ONCE,
  )
  if (!res.ok) {
    return {
      ok: false,
      reason:
        res.status === null
          ? 'GitHub did not answer. Nothing changed.'
          : `GitHub refused to start a sign-in (${String(res.status)}). Nothing changed.`,
    }
  }
  const b = res.body
  if (
    b.device_code === undefined ||
    b.user_code === undefined ||
    b.verification_uri === undefined
  ) {
    const step = readDeviceReply({ error: b.error }, 5)
    return { ok: false, reason: step.kind === 'stop' ? step.reason : 'GitHub issued no code.' }
  }

  const now = Date.now()
  sweep(now)
  const interval = Math.max(5, b.interval ?? 5)
  const expiresAt = now + (b.expires_in ?? 900) * 1000
  const flow = randomUUID()
  flows.set(flow, {
    deviceCode: b.device_code,
    clientId,
    expiresAt,
    interval,
    nextPollAt: now + interval * 1000,
    busy: false,
  })
  return {
    ok: true,
    flow,
    userCode: b.user_code,
    verificationUri: b.verification_uri,
    expiresAt: new Date(expiresAt).toISOString(),
    interval,
  }
}

export async function pollGithubSignIn(
  ctx: Ctx,
  actor: string,
  flowId: string,
): Promise<SignInPoll> {
  const f = flows.get(flowId)
  if (f === undefined) {
    return { state: 'failed', reason: 'This sign-in is no longer open. Start again.' }
  }
  const now = Date.now()
  if (now >= f.expiresAt) {
    flows.delete(flowId)
    return { state: 'failed', reason: 'The code expired before it was approved. Start again.' }
  }
  // An early or overlapping poll is answered from here. GitHub counts polls,
  // and a slow_down it hands out lasts for the rest of the flow.
  if (f.busy || now < f.nextPollAt) return { state: 'pending', interval: f.interval }

  f.busy = true
  try {
    const res = await getJsonResult<DeviceTokenReply>(
      'https://github.com/login/oauth/access_token',
      {
        method: 'POST',
        headers: FORM,
        body: new URLSearchParams({
          client_id: f.clientId,
          device_code: f.deviceCode,
          grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
        }).toString(),
      },
      ONCE,
    )
    if (!res.ok && res.status === null) {
      // No answer is not a refusal: ask again after the interval.
      f.nextPollAt = Date.now() + f.interval * 1000
      return { state: 'pending', interval: f.interval }
    }
    const step: DeviceStep = res.ok
      ? readDeviceReply(res.body, f.interval)
      : {
          kind: 'stop',
          reason: `GitHub answered ${String(res.status)} to the sign-in. Nothing changed.`,
        }
    if (step.kind === 'wait') {
      f.interval = step.interval
      f.nextPollAt = Date.now() + step.interval * 1000
      return { state: 'pending', interval: step.interval }
    }
    flows.delete(flowId)
    if (step.kind === 'stop') return { state: 'failed', reason: step.reason }
    return await adopt(ctx, actor, step.token)
  } finally {
    f.busy = false
  }
}

/** Check the new token for what the box does with it, then seal and apply it. */
async function adopt(ctx: Ctx, actor: string, token: string): Promise<SignInPoll> {
  const failed = (reason: string): SignInPoll => ({ state: 'failed', reason })
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'X-GitHub-Api-Version': '2022-11-28',
  }

  let login = ''
  let scopes: string | null = null
  try {
    const res = await fetch(`${API}/user`, { headers, signal: AbortSignal.timeout(8_000) })
    if (!res.ok) {
      return failed(`GitHub did not accept the new token (${String(res.status)}). Nothing changed.`)
    }
    scopes = res.headers.get('x-oauth-scopes')
    login = ((await res.json()) as { login?: string }).login ?? ''
  } catch {
    return failed('GitHub did not answer while the new token was checked. Nothing changed.')
  }

  if (login.toLowerCase() !== OWNER.toLowerCase()) {
    return failed(
      `That signed in as ${login === '' ? 'an unknown account' : login}, but this box's repositories live under ${OWNER}. Sign in to GitHub as ${OWNER} and start again. Nothing changed.`,
    )
  }
  const missing = missingScopes(scopes)
  if (missing.length > 0) {
    return failed(`GitHub granted the token without ${missing.join(', ')}. Nothing changed.`)
  }

  const repos = await getJsonResult<{ full_name?: string }[]>(
    `${API}/user/repos?affiliation=owner&sort=pushed&per_page=1`,
    { headers },
  )
  const probe = repos.ok ? repos.body[0]?.full_name : undefined
  if (probe !== undefined) {
    const runners = await getJsonResult(`${API}/repos/${probe}/actions/runners?per_page=1`, {
      headers,
    })
    if (!runners.ok) {
      return failed(
        `The token cannot read ${probe}'s self-hosted runners (${runners.status === null ? 'no answer' : String(runners.status)}), which the box's CI runners need. Nothing changed.`,
      )
    }
  }

  const sealed = await sealForVault(GITHUB_TOKEN_FILE, token)
  if (!sealed.ok) return failed(sealed.reason)

  const { runSecretApply } = await import('../../lib/apply-flow')
  const outcome = await runSecretApply(actor, {
    file: GITHUB_TOKEN_FILE,
    name: GITHUB_TOKEN_SECRET,
    ciphertext: sealed.ciphertext,
  })
  if (!outcome.ok) return failed(outcome.reason)
  return {
    state: 'done',
    id: outcome.id,
    login,
    inUse: ctx.env('GITHUB_TOKEN_FROM_SITE') === '1',
  }
}
