import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

// The merged environment a container actually has, as published by
// daedalus-env-snapshot (stacks/daedalus/host/env-snapshot.sh).
//
// Read from the container rather than re-derived: it is the only place where
// what the platform injects, what the registry declares, what the image bakes
// in, and every --env-file value are already combined. Reconstructing it here
// would mean reimplementing stacks/apps and then drifting from it.

const ENV_DIR = process.env.ENV_SNAPSHOT_DIR ?? '/env-snapshot'

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
const PLATFORM_KEYS: Record<string, EnvGroup> = {
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
const IMAGE_KEYS = new Set([
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

export type EnvSnapshot = {
  vars: EnvVar[]
  /** When the snapshot was taken; the UI shows this so nobody reads a stale env as current. */
  takenAt: string | null
  available: boolean
}

/**
 * @param declared keys the registry declares for this app, used only to label
 *        origin — the VALUES always come from the container.
 * @param hasSecretsFile whether the app has a tracked <name>-env.sops. Without
 *        it, an unrecognised key can only have come from the image; with it,
 *        the sops file is by far the likelier source, and saying so is more
 *        useful than a shrug.
 */
export async function readEnvSnapshot(
  app: string,
  declared: Map<string, string | null>,
  hasSecretsFile = false,
): Promise<EnvSnapshot> {
  const path = join(ENV_DIR, `${app}.json`)

  let raw: string
  let takenAt: string | null = null
  try {
    ;[raw, takenAt] = await Promise.all([
      readFile(path, 'utf8'),
      stat(path).then((s) => s.mtime.toISOString()),
    ])
  } catch {
    // No snapshot: the app has no running container, or the timer has not run
    // since it started. Reported as unavailable rather than as "no variables",
    // which would read as a configuration fact rather than a missing file.
    return { vars: [], takenAt: null, available: false }
  }

  let entries: string[]
  try {
    entries = JSON.parse(raw) as string[]
  } catch {
    return { vars: [], takenAt, available: false }
  }

  const vars: EnvVar[] = entries.map((entry) => {
    // Split on the FIRST '=' only: values legitimately contain '=' (a
    // DATABASE_URL query string, a base64 secret).
    const eq = entry.indexOf('=')
    const key = eq === -1 ? entry : entry.slice(0, eq)
    const value = eq === -1 ? '' : entry.slice(eq + 1)

    // Order matters. A registry declaration wins over everything — if the
    // author wrote it down, that is where it came from. Then the explicit
    // platform list, then the base image. Whatever is left is the app's own
    // sops file if it has one, and genuinely unknown if it does not.
    const origin: EnvOrigin =
      declared.has(key) ? 'registry'
      : key in PLATFORM_KEYS ? 'platform'
      : IMAGE_KEYS.has(key) ? 'image'
      : hasSecretsFile ? 'secrets'
      : 'image'

    const group: EnvGroup =
      origin === 'platform' ? (PLATFORM_KEYS[key] ?? 'other')
      : origin === 'image' ? 'runtime'
      : 'other'

    return {
      key,
      value,
      secret: isSecret(key),
      origin,
      group,
      note: declared.get(key) ?? null,
    }
  })

  vars.sort((a, b) => a.key.localeCompare(b.key))
  return { vars, takenAt, available: true }
}
