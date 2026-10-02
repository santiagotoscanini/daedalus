import { getJsonResult } from '../../lib/http'
import type { Result } from '../../lib/result'
import {
  VERCEL_TOKEN_FILE,
  VERCEL_TOKEN_SECRET,
  vercelTokenShapeError,
} from '../../lib/vercel-token'
import type { Ctx } from '../ctx'
import { VERCEL_API } from '../offbox/vercel'
import { sealForVault } from '../vault'

// Settings › Integrations › Vercel › Replace token.
//
// The Cloudflare token's order (core/settings/cloudflare-token.ts), for a
// token the box only ever reads with: the candidate is checked against
// Vercel doing what the off-box list does with it — naming its user and
// listing projects — so a token that would show nothing is refused before
// anything changes. Only then is it encrypted HERE for site/vault/ (the
// container can write the secret and never read it back), and the
// ciphertext goes to Apply as its own change; nix renders it into the
// control plane's env (nix/stacks/daedalus/dashboard-keys.nix).
//
// The token is never stored, logged or returned.

/** The Apply's request id, and who the new token reads as. */
export type VercelTokenOutcome = Result<{ id: string; user: string }>

async function check(token: string): Promise<Result<string>> {
  const headers = { Authorization: `Bearer ${token}` }
  const user = await getJsonResult<{ user?: { username?: unknown } }>(`${VERCEL_API}/v2/user`, {
    headers,
  })
  if (!user.ok) {
    return {
      ok: false,
      reason:
        user.reason.status === null
          ? 'Vercel did not answer; nothing was changed.'
          : 'Vercel does not recognise this token.',
    }
  }
  const name = typeof user.value.user?.username === 'string' ? user.value.user.username : 'unknown'
  const teams = await getJsonResult<{ teams?: { id?: unknown }[] }>(
    `${VERCEL_API}/v2/teams?limit=1`,
    {
      headers,
    },
  )
  const team =
    teams.ok && typeof teams.value.teams?.[0]?.id === 'string' ? teams.value.teams[0].id : null
  const projects = await getJsonResult(
    `${VERCEL_API}/v10/projects?limit=1${team === null ? '' : `&teamId=${encodeURIComponent(team)}`}`,
    { headers },
  )
  if (!projects.ok) {
    return {
      ok: false,
      reason: 'The token cannot list projects; give it the team that holds them.',
    }
  }
  return { ok: true, value: name }
}

export async function replaceVercelToken(
  ctx: Ctx,
  actor: string,
  raw: string,
): Promise<VercelTokenOutcome> {
  const token = raw.trim()
  const shape = vercelTokenShapeError(token)
  if (shape !== null) return { ok: false, reason: shape }
  if (token === ctx.secret('VERCEL_API_TOKEN')) {
    return { ok: false, reason: 'That is the token the box already uses.' }
  }

  const checked = await check(token)
  if (!checked.ok) return checked

  const sealed = await sealForVault(VERCEL_TOKEN_FILE, token)
  if (!sealed.ok) return sealed

  const { runSecretApply } = await import('../../host/apply-flow')
  const outcome = await runSecretApply(ctx, actor, {
    file: VERCEL_TOKEN_FILE,
    name: VERCEL_TOKEN_SECRET,
    ciphertext: sealed.value,
  })
  return outcome.ok
    ? { ok: true, value: { id: outcome.id, user: checked.value } }
    : { ok: false, reason: outcome.reason }
}
