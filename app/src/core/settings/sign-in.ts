import { errorText } from '../../lib/redact'
import type { Result } from '../../lib/result'
import type { Ctx } from '../ctx'

// Settings › Sign-in's Test: does this issuer answer as an OIDC provider, and
// under its own name. Saving a wrong issuer is how an Apply locks the operator
// out, so the page can ask before the Apply does.

type Discovery = { issuer?: unknown; authorization_endpoint?: unknown }

/** The issuer's authorization endpoint, or why a sign-in against it would fail. */
export async function testIssuer(
  ctx: Pick<Ctx, 'http'>,
  issuer: string,
): Promise<Result<{ authorizationEndpoint: string }>> {
  const base = issuer.replace(/\/+$/, '')
  try {
    const d = await ctx.http.getJson<Discovery>(`${base}/.well-known/openid-configuration`)
    if (d === null || typeof d.authorization_endpoint !== 'string') {
      return { ok: false, reason: 'That address has no OIDC discovery document.' }
    }
    if (typeof d.issuer !== 'string' || d.issuer.replace(/\/+$/, '') !== base) {
      return { ok: false, reason: 'That document names a different issuer.' }
    }
    return { ok: true, value: { authorizationEndpoint: d.authorization_endpoint } }
  } catch (e) {
    return { ok: false, reason: errorText(e) }
  }
}
