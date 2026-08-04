// Pure classification of environment variables — NO node builtins.
//
// Split out of env-snapshot.ts deliberately. That module reads the snapshot
// off disk, so importing anything from it — even a plain lookup table — drags
// `node:fs/promises` into the client bundle and Vite externalises it, which
// fails at runtime with "Module has been externalized for browser
// compatibility". The detail page renders these labels, so they have to live
// somewhere a browser can import.
//
// Rule of thumb for this codebase: a module a route imports VALUES from must
// be free of node builtins. Type-only imports are erased and are always safe.

/**
 * Where a variable came from — which is also who can change it.
 *
 *   platform  the apps module injected it (stacks/apps/apps.nix) or a feature
 *             toggle did. Read-only here: it moves when the toggle moves.
 *   registry  declared in apps.json, so it round-trips through daedalus.
 *   secrets   from the app's <name>-env.sops. Host-managed — `sops` on the
 *             box, never through this UI.
 *   image     baked into the base image or set by podman.
 */
export type EnvOrigin = 'platform' | 'registry' | 'secrets' | 'image'

/** Sub-grouping within `platform`: which feature put it there. */
export type EnvGroup =
  | 'identity'
  | 'database'
  | 'auth'
  | 'sso'
  | 'litellm'
  | 'observability'
  | 'runtime'
  | 'other'

export type EnvVar = {
  key: string
  value: string
  secret: boolean
  origin: EnvOrigin
  group: EnvGroup
  note?: string | null
}

/**
 * Platform-injected keys, by the feature that injects them.
 *
 * An explicit list rather than a prefix rule, because the prefixes lie in both
 * directions: `DB_POSTGRESDB_PASSWORD` and `GF_DATABASE_PASSWORD` are the
 * shared cluster's doing (stacks/app-db emits the same password under every
 * name a stock image might read), while an app's own `DB_HOST` would not be.
 * A key that is not on this list is not silently called "platform".
 */
export const PLATFORM_KEYS: Record<string, EnvGroup> = {
  APP_NAME: 'identity',
  APP_HOSTNAME: 'identity',
  APP_PUBLIC_URL: 'identity',
  PORT: 'identity',
  TZ: 'identity',

  DATABASE_URL: 'database',
  DB_CONNECTION_STRING: 'database',
  DB_PASS: 'database',
  DB_PASSWORD: 'database',
  DB_POSTGRESDB_PASSWORD: 'database',
  GF_DATABASE_PASSWORD: 'database',
  POSTGRES_DB: 'database',
  POSTGRES_USER: 'database',
  POSTGRES_PASSWORD: 'database',

  AUTH_SECRET: 'auth',
  AUTH_TRUST_HOST: 'auth',
  AUTH_URL: 'auth',

  OIDC_CLIENT_ID: 'sso',
  OIDC_CLIENT_SECRET: 'sso',
  OIDC_ISSUER_URL: 'sso',
  OIDC_PROVIDER_ID: 'sso',
  OIDC_PROVIDER_NAME: 'sso',
  OIDC_REDIRECT_URI: 'sso',
  OIDC_SCOPES: 'sso',

  LITELLM_BASE_URL: 'litellm',
  LITELLM_API_KEY: 'litellm',

  PROMETHEUS_URL: 'observability',
  LOKI_URL: 'observability',
}

export const GROUP_LABELS: Record<EnvGroup, { title: string; icon: string; hint: string }> = {
  identity: {
    title: 'Identity',
    icon: '◈',
    hint: 'Who the app is and where it answers. Follows the hostname.',
  },
  database: {
    title: 'Database',
    icon: '⛁',
    hint: 'The shared pg cluster emits the same password under every name a stock image might read.',
  },
  auth: {
    title: 'Session auth',
    icon: '⚿',
    hint: 'Auth.js needs the public host, not the container name, or every callback fails.',
  },
  sso: { title: 'Pocket ID (SSO)', icon: '⛨', hint: 'Native OIDC. Present only in auth.mode = native.' },
  litellm: { title: 'LiteLLM gateway', icon: '✦', hint: 'The AI gateway, when the toggle is on.' },
  observability: {
    title: 'Observability',
    icon: '◎',
    hint: 'Prometheus and Loki, for apps that read their own metrics.',
  },
  runtime: { title: 'Runtime', icon: '▤', hint: 'Set by the base image or by podman itself.' },
  other: { title: 'Other', icon: '·', hint: '' },
}

/**
 * Names whose VALUES are withheld until explicitly revealed.
 *
 * Matched on the name, not the value: a heuristic on content would both miss
 * things and mangle innocent ones. Deliberately broad — a false positive costs
 * one click, a false negative prints a database password into a screenshot.
 */
const SECRET_RE =
  /(SECRET|PASSWORD|PASSWD|_PASS$|TOKEN|API_?KEY|_KEY$|^KEY$|PEPPER|CREDENTIAL|DATABASE_URL|CONNECTION_STRING|DSN)/i

/** Baked into the base image or set by podman — context, not configuration. */
export const IMAGE_KEYS = new Set([
  'PATH',
  'HOME',
  'HOSTNAME',
  'HOST',
  'TERM',
  'container',
  'NODE_VERSION',
  'NODE_ENV',
  'YARN_VERSION',
  'COREPACK_HOME',
  'LANG',
  'SHLVL',
  'PWD',
])

export function isSecret(key: string): boolean {
  return SECRET_RE.test(key)
}
