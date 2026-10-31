import { env } from '../host/env'

// Which identity provider signs a person in, resolved once from two layers.
//
// The box's own: a host running Pocket ID hands the container OIDC_* and the
// client's generated secret, because daedalus is a `native` app on the apps
// platform (nix/modules/apps/apps.nix). That needs no setting at all.
//
// Settings › Sign-in: AUTH_OIDC_*, which nix binds from site.json's `oidc`
// block and the vault's AUTH_OIDC_CLIENT_SECRET. Each one replaces the box's
// value for that field alone, so the same page can point at any other IdP, and
// a blank field is the box's word. Both arrive through the environment, so a
// change reaches this process through an Apply, like every other site fact.

/** Where the client's secret came from. Never the secret itself. */
export type OidcSecretSource = 'settings' | 'box' | 'none'

export type OidcConfig = {
  issuer: string
  clientId: string
  clientSecret: string
  /** What the sign-in button calls the provider. */
  name: string
  /** Half of the redirect URI registered at the IdP: Auth.js's `callback/<id>`. */
  providerId: string
  scopes: string
}

const given = (v: string | undefined): string | undefined => {
  const t = v?.trim() ?? ''
  return t === '' ? undefined : t
}

const issuer = () => given(env.get('AUTH_OIDC_ISSUER')) ?? given(env.get('OIDC_ISSUER_URL'))
const clientId = () => given(env.get('AUTH_OIDC_CLIENT_ID')) ?? given(env.get('OIDC_CLIENT_ID'))

/** The provider's name, whether or not the rest of it is configured. */
export const oidcName = (): string =>
  given(env.get('AUTH_OIDC_NAME')) ??
  given(env.get('OIDC_PROVIDER_NAME')) ??
  'your identity provider'

export function oidcSecretSource(): OidcSecretSource {
  if (given(env.get('AUTH_OIDC_CLIENT_SECRET')) !== undefined) return 'settings'
  return given(env.get('OIDC_CLIENT_SECRET')) !== undefined ? 'box' : 'none'
}

/** The provider in force, or null: a field is missing, so nobody can sign in with it. */
export function oidcConfig(): OidcConfig | null {
  const iss = issuer()
  const id = clientId()
  const secret = given(env.get('AUTH_OIDC_CLIENT_SECRET')) ?? given(env.get('OIDC_CLIENT_SECRET'))
  if (iss === undefined || id === undefined || secret === undefined) return null
  return {
    issuer: iss,
    clientId: id,
    clientSecret: secret,
    name: oidcName(),
    providerId: given(env.get('OIDC_PROVIDER_ID')) ?? 'pocket-id',
    scopes: given(env.get('OIDC_SCOPES')) ?? 'openid profile email groups',
  }
}

/** What Settings › Sign-in shows about the provider in force. No secret crosses. */
export const oidcFacts = () => ({
  issuer: issuer() ?? null,
  clientId: clientId() ?? null,
  name: oidcName(),
  secret: oidcSecretSource(),
  callbackUrl: given(env.get('OIDC_REDIRECT_URI')) ?? null,
  configured: oidcConfig() !== null,
})
