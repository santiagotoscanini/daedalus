// The environment, as one schema.
//
// Every variable this app understands is a row in SCHEMA: its shape, whether
// the app can run without it, what it is for and which nix binding sets it.
// Nothing is read from a .env file. A name that is not a row does not compile
// (`env.get('WAN_HSOT')`), and `Ctx.env` is typed against the same union, so
// a module loader gets the same check.
//
// Three rules the accessor holds:
//
//   required   — missing or malformed throws EnvError, one sentence naming the
//                variable. Only what the app cannot serve a page without is
//                required; today that is the database.
//   optional   — missing reads as undefined (or the row's fallback). Malformed
//                reads the same way and logs one warning line per name per
//                process. LiteLLM's pair is here: an install without the
//                gateway is a supported box, and the pages that use it say
//                "not configured".
//   values     — no message this module produces carries a value. A malformed
//                DATABASE_URL is still a password.
//
// Read at USE, never cached: a container missing a variable one page needs
// still serves the other twenty, and tests set `process.env` between calls.
// `reportEnvOnce()` is the whole-table pass, run once per process from
// /api/healthz — the first thing gatus and the deploy unit ask a new process.
//
// Two groups are listed and not read here. APP_HOSTNAME_ALIASES and
// APP_EXTRA_HOSTS are read by vite.config.ts before any of `src` exists. The
// DASH_* credentials are rows too, read through host/keys.ts, whose names are
// typed from here.
//
// No row is read through `import.meta.env`. Vite inlines that into both
// bundles at build time, and an image is built once for every box: the box's
// identity (BASE_DOMAIN and its three siblings) is read at run time by
// host/site.ts, and reaches the browser in the root loader's data.
//
// Never import this from a client component: `process` does not exist in the
// browser, and half these rows are credentials.

type Kind = 'string' | 'url' | 'dsn' | 'path' | 'int' | 'flag' | 'list'

type KindValue = {
  string: string
  url: string
  dsn: string
  path: string
  int: number
  flag: boolean
  list: string[]
}

type Spec = {
  kind: Kind
  /** The app refuses to run without it. */
  required?: true
  /** A credential. Listed by name; no message ever carries its value. */
  secret?: true
  /** What an absent or malformed value reads as. Parsed like a bound one. */
  fallback?: string
  about: string
  /** The nix binding in the config repository, or why there is none. */
  source: string
  /** Who reads it, when it is not `env.get`. */
  reader?: 'host/site.ts' | 'vite.config.ts' | 'host/keys.ts'
}

const DAEDALUS = 'stacks/daedalus/daedalus.nix'
const APPS = 'stacks/apps/apps.nix (every fleet app)'
const SERVICE_KEYS = `${DAEDALUS} daedalus-dashboard-keys, from service-keys.sops`
const LEGACY = 'a config that predates the rename; bind the bare name instead'
const UNBOUND = 'unbound — an override for tests and a bare checkout'

const dash = (about: string, source = SERVICE_KEYS) =>
  ({ kind: 'string', secret: true, about, source, reader: 'host/keys.ts' }) as const

export const SCHEMA = {
  // ── required ─────────────────────────────────────────────────────────────
  DATABASE_URL: {
    kind: 'dsn',
    required: true,
    secret: true,
    about: 'The app’s own database on the shared cluster.',
    source: 'stacks/app-db, the per-app env file fleet.appDatabases renders',
  },

  // ── the LLM gateway — optional as a pair ─────────────────────────────────
  LITELLM_BASE_URL: {
    kind: 'url',
    about: 'The LiteLLM gateway. Absent on a box without one.',
    source: 'stacks/apps/apps.nix, when the app sets litellm = true',
  },
  LITELLM_API_KEY: {
    kind: 'string',
    secret: true,
    about: 'The gateway’s master key, for the AI module’s LiteLLM tab.',
    source: 'stacks/litellm fleet.dashboard.litellm.envFiles (litellm-daedalus-key)',
  },

  // ── this app, as the platform names it ───────────────────────────────────
  APP_NAME: { kind: 'string', about: 'This app’s registry name.', source: APPS },
  APP_HOSTNAME: {
    kind: 'string',
    about: 'The hostname the control plane is served at.',
    source: APPS,
  },
  APP_PUBLIC_URL: { kind: 'url', about: 'https://<APP_HOSTNAME>.', source: APPS },
  APP_HOSTNAME_ALIASES: {
    kind: 'list',
    about: 'Further hostnames the dev server answers to.',
    source: APPS,
    reader: 'vite.config.ts',
  },
  APP_EXTRA_HOSTS: {
    kind: 'list',
    about: 'Public names routed here besides the app’s own — the webhook host.',
    source: DAEDALUS,
    reader: 'vite.config.ts',
  },
  TZ: {
    kind: 'string',
    about: 'The box’s timezone, until site.json names one.',
    source: 'platform/podman.nix (every container)',
  },
  // The box's identity — read through host/site.ts, and only there.
  BASE_DOMAIN: {
    kind: 'string',
    about: 'The domain every published host is one label under.',
    source: DAEDALUS,
    reader: 'host/site.ts',
  },
  GITHUB_OWNER: {
    kind: 'string',
    about: 'The GitHub account the fleet’s repositories live under.',
    source: DAEDALUS,
    reader: 'host/site.ts',
  },
  REGISTRY_HOST: {
    kind: 'string',
    about: 'The image registry’s hostname, for image references.',
    source: 'stacks/registry fleet.dashboard.registry.env',
    reader: 'host/site.ts',
  },
  GRAFANA_URL: {
    kind: 'url',
    about: 'Grafana, for the log and dashboard links.',
    source: 'stacks/monitoring fleet.dashboard.monitoring.env',
    reader: 'host/site.ts',
  },
  // The same four under the names they had while Vite inlined them. Read
  // second, so a config that has not renamed its bindings keeps working.
  VITE_BASE_DOMAIN: {
    kind: 'string',
    about: 'BASE_DOMAIN, as it was bound.',
    source: LEGACY,
    reader: 'host/site.ts',
  },
  VITE_GITHUB_OWNER: {
    kind: 'string',
    about: 'GITHUB_OWNER, as it was bound.',
    source: LEGACY,
    reader: 'host/site.ts',
  },
  VITE_REGISTRY_HOST: {
    kind: 'string',
    about: 'REGISTRY_HOST, as it was bound.',
    source: LEGACY,
    reader: 'host/site.ts',
  },
  VITE_GRAFANA_URL: {
    kind: 'url',
    about: 'GRAFANA_URL, as it was bound.',
    source: LEGACY,
    reader: 'host/site.ts',
  },

  // ── where the host's read-only mounts are ────────────────────────────────
  EXPORT_DIR: {
    kind: 'path',
    fallback: '/export',
    about: 'The versioned fleet.export domains.',
    source: DAEDALUS,
  },
  APPLY_DIR: {
    kind: 'path',
    fallback: '/apply',
    about: 'The file-drop bridge: the one writable mount.',
    source: DAEDALUS,
  },
  SITE_PATH: {
    kind: 'path',
    fallback: '/site',
    about: 'The committed site directory.',
    source: DAEDALUS,
  },
  NIX_MANIFEST_PATH: {
    kind: 'path',
    about: 'The nix manifest: hand-written entries and webApp hosts.',
    source: DAEDALUS,
  },
  NIX_REGISTRY_PATH: {
    kind: 'path',
    about: 'The app registry nix last built.',
    source: DAEDALUS,
  },
  IMAGE_LABELS_PATH: {
    kind: 'path',
    fallback: '/images/labels.json',
    about: 'Labels baked into the images on disk.',
    source: DAEDALUS,
  },
  IMAGE_FRESHNESS_PATH: {
    kind: 'path',
    fallback: '/images/freshness.json',
    about: 'Digest-against-tag freshness, published daily.',
    source: DAEDALUS,
  },
  HOST_FACTS_PATH: {
    kind: 'path',
    fallback: '/system/system.json',
    about: 'SMART, ZFS and generations.',
    source: DAEDALUS,
  },
  CLAUDE_FACTS_PATH: {
    kind: 'path',
    fallback: '/claude/claude.json',
    about: 'Remote Control’s state.',
    source: DAEDALUS,
  },
  REPO_FACTS_PATH: {
    kind: 'path',
    fallback: '/repo/repo.json',
    about: 'The configuration repository’s git facts.',
    source: DAEDALUS,
  },
  WORKSPACES_PATH: {
    kind: 'path',
    fallback: '/workspaces/workspaces.json',
    about: 'The project workspaces snapshot.',
    source: DAEDALUS,
  },
  WORKSPACE_ROOT: {
    kind: 'path',
    about: 'Where clones land on the host. Display only.',
    source: DAEDALUS,
  },
  ENGINE_DOCS_DIR: {
    kind: 'path',
    about: 'The engine repository root, for the MCP server’s docs.',
    source: DAEDALUS,
  },
  DHCP_HOSTS_PATH: {
    kind: 'path',
    about: 'The DHCP reservations pi-hole renders.',
    source: 'stacks/pihole fleet.dashboard.pihole.env',
  },
  GITHUB_TOKEN_PATH: {
    kind: 'path',
    about: 'The GitHub App’s minted installation token.',
    source: DAEDALUS,
  },
  GITHUB_APP_DIR: {
    kind: 'path',
    about: 'The directory holding the App’s webhook secret.',
    source: DAEDALUS,
  },
  BUILD_LOGS_PATH: {
    kind: 'path',
    about: 'The host builder’s redacted logs.',
    source: `${DAEDALUS}, once the GitHub App exists`,
  },
  SHOTTER_DIR: {
    kind: 'path',
    fallback: '/shotter',
    about: 'Shotter’s run archive; the mount is stacks/shotter’s.',
    source: UNBOUND,
  },
  DEPLOY_STATE_DIR: {
    kind: 'path',
    fallback: '/deploy-state',
    about: 'Each app’s last deploy result.',
    source: UNBOUND,
  },
  ENV_SNAPSHOT_DIR: {
    kind: 'path',
    fallback: '/env-snapshot',
    about: 'The fleet apps’ env-file snapshot.',
    source: UNBOUND,
  },
  ENGINE_PACKAGE_JSON: {
    kind: 'path',
    about: 'The package.json the Engine card reads its version from.',
    source: UNBOUND,
  },

  // ── services the pages dial ──────────────────────────────────────────────
  PROMETHEUS_URL: {
    kind: 'url',
    fallback: 'http://prometheus:9090',
    about: 'Prometheus, over the monitoring bridge.',
    source: DAEDALUS,
  },
  LOKI_URL: {
    kind: 'url',
    fallback: 'http://loki:3100',
    about: 'Loki, over the monitoring bridge.',
    source: DAEDALUS,
  },
  REGISTRY_URL: {
    kind: 'url',
    about: 'The image registry’s API. https://<REGISTRY_HOST> when unset.',
    source: 'stacks/registry fleet.dashboard.registry.env',
  },
  PIHOLE_URL: {
    kind: 'url',
    about: 'Pi-hole’s API.',
    source: 'stacks/pihole fleet.dashboard.pihole.env',
  },
  ROUTER_URL: {
    kind: 'url',
    about: 'The router’s login page, for the build stamp it carries.',
    source: DAEDALUS,
  },
  ROUTER_ADMIN_URL: {
    kind: 'url',
    about: 'The router’s admin UI, as a link for a person.',
    source: DAEDALUS,
  },
  DEPLOY_HOOK_TOKEN: {
    kind: 'string',
    secret: true,
    about: 'What the registry’s push event must present at /api/deploy.',
    source: 'stacks/registry fleet.dashboard.registry.envFiles (registry-daedalus-token)',
  },

  // ── what the box is ──────────────────────────────────────────────────────
  LAN_IP: { kind: 'string', about: 'The box’s LAN address.', source: DAEDALUS },
  GATEWAY_IP: { kind: 'string', about: 'The default route: the router.', source: DAEDALUS },
  WAN_HOST: {
    kind: 'string',
    about: 'The split-horizon name the game servers are reached by.',
    source: DAEDALUS,
  },
  ROUTER_PRODUCT: {
    kind: 'string',
    about: 'The router’s product name, which its build stamp lacks.',
    source: DAEDALUS,
  },
  DDNS_HOST: { kind: 'string', about: 'The name ddclient maintains.', source: DAEDALUS },
  DDNS_INTERVAL: {
    kind: 'string',
    about: 'ddclient’s poll interval, as its service states it.',
    source: DAEDALUS,
  },
  CF_ZONE_ID: { kind: 'string', about: 'The Cloudflare zone of the domain.', source: DAEDALUS },
  CF_ACCOUNT_ID: {
    kind: 'string',
    about: 'The Cloudflare account the tunnel belongs to.',
    source: 'stacks/cloudflared fleet.dashboard.cloudflared.env',
  },
  CF_TUNNEL_ID: {
    kind: 'string',
    about: 'The Cloudflare tunnel.',
    source: 'stacks/cloudflared fleet.dashboard.cloudflared.env',
  },
  GITHUB_APP_ENABLED: {
    kind: 'flag',
    about: 'The host accepts the GitHub App’s vault file, so creating one is offered.',
    source: DAEDALUS,
  },
  DAEDALUS_DEV: {
    kind: 'flag',
    about:
      'This instance is the dev server over a bind-mounted checkout (fleet.daedalus.dev), not the built bundle.',
    source: DAEDALUS,
  },

  // ── pinned versions, each from the stack that pins it ────────────────────
  DDCLIENT_VERSION: { kind: 'string', about: 'ddclient’s package version.', source: DAEDALUS },
  PIHOLE_VERSION: {
    kind: 'string',
    about: 'pihole-ftl’s package version.',
    source: 'stacks/pihole fleet.dashboard.pihole.env',
  },
  POCKET_ID_VERSION: {
    kind: 'string',
    about: 'Pocket ID’s image version.',
    source: 'stacks/pocket-id fleet.dashboard.pocket-id.env',
  },
  N8N_VERSION: {
    kind: 'string',
    about: 'n8n’s image version.',
    source: 'stacks/n8n fleet.dashboard.n8n.env',
  },
  WG_EASY_VERSION: {
    kind: 'string',
    about: 'wg-easy’s image version.',
    source: 'stacks/wg-easy fleet.dashboard.wg-easy.env',
  },
  FACTORIO_VERSION: {
    kind: 'string',
    about: 'The Factorio server’s version.',
    source: 'stacks/factorio fleet.dashboard.factorio.env',
  },
  MINECRAFT_VERSION: {
    kind: 'string',
    about: 'The Minecraft version Paper is pinned to.',
    source: 'stacks/minecraft fleet.dashboard.minecraft.env',
  },
  MINECRAFT_PAPER_BUILD: {
    kind: 'int',
    about: 'The Paper build number.',
    source: 'stacks/minecraft fleet.dashboard.minecraft.env',
  },
  MCP_GROCY_VERSION: {
    kind: 'string',
    about: 'mcp-grocy’s image version.',
    source: 'stacks/grocy-mcp fleet.dashboard.grocy-mcp.env',
  },
  YAZIO_MCP_VERSION: {
    kind: 'string',
    about: 'yazio-mcp’s npm version.',
    source: 'stacks/yazio-mcp fleet.dashboard.yazio-mcp.env',
  },
  SUPERGATEWAY_VERSION: {
    kind: 'string',
    about: 'The supergateway fronting yazio-mcp.',
    source: 'stacks/yazio-mcp fleet.dashboard.yazio-mcp.env',
  },
  PGVECTOR_REV: {
    kind: 'string',
    about: 'The source commit litellm-pgvector is built from.',
    source: 'stacks/litellm-pgvector fleet.dashboard.litellm-pgvector.env',
  },
  SHOTTER_PLAYWRIGHT_VERSION: {
    kind: 'string',
    about: 'The Playwright the shotter image carries.',
    source: 'stacks/shotter fleet.dashboard.shotter.env',
  },

  // ── service credentials — read through host/keys.ts ──────────────────────
  DASH_CF_API_TOKEN: dash(
    'The box’s one Cloudflare token. Only ever GETs here.',
    `${DAEDALUS} daedalus-dashboard-keys, from site/vault/cloudflare-api-token.sops`,
  ),
  DASH_POCKETID_KEY: dash(
    'Pocket ID’s admin API key.',
    'stacks/pocket-id fleet.dashboard.pocket-id.envFiles (pocket-id-daedalus-key)',
  ),
  DASH_GITHUB_REPO_TOKEN: dash('A read-only PAT for the repo picker. Empty by default.'),
  DASH_JELLYFIN_API_KEY: dash('Jellyfin.'),
  DASH_SONARR_API_KEY: dash('Sonarr.'),
  DASH_RADARR_API_KEY: dash('Radarr.'),
  DASH_BAZARR_API_KEY: dash('Bazarr.'),
  DASH_PROWLARR_API_KEY: dash('Prowlarr.'),
  DASH_SEERR_API_KEY: dash('Seerr.'),
  DASH_QBT_USER: dash('qBittorrent’s WebUI user.'),
  DASH_QBT_PASS: dash('qBittorrent’s WebUI password.'),
  DASH_IMMICH_API_KEY: dash('Immich.'),
  DASH_NEXTCLOUD_KEY: dash('Nextcloud’s serverinfo token.'),
  DASH_HASS_API_KEY: dash('Home Assistant’s long-lived token.'),
  DASH_GROCY_API_KEY: dash('Grocy.'),
  DASH_N8N_API_KEY: dash('n8n.'),
  DASH_OPENWEBUI_KEY: dash('Open WebUI.'),
  DASH_CALIBREWEB_USER: dash('Calibre-Web’s user.'),
  DASH_CALIBREWEB_PASS: dash('Calibre-Web’s password.'),
  DASH_GRAFANA_USER: dash('Grafana’s break-glass admin.'),
  DASH_GRAFANA_PASS: dash('Grafana’s break-glass password.'),
  DASH_HEALTHCHECKS_API_KEY: dash('The dead-man pings’ read key.'),
} as const satisfies Record<string, Spec>

export type EnvName = keyof typeof SCHEMA

/** A row a loader may read as configuration: every name that is not a credential. */
export type ConfigName = {
  [N in EnvName]: (typeof SCHEMA)[N] extends { secret: true } ? never : N
}[EnvName]

/** A DASH_* credential, by the name host/keys.ts takes: `JELLYFIN_API_KEY`. */
export type SecretName = EnvName extends infer N ? (N extends `DASH_${infer S}` ? S : never) : never

type SpecOf<N extends EnvName> = (typeof SCHEMA)[N]
type Parsed<N extends EnvName> = KindValue[SpecOf<N>['kind']]
type Absent<N extends EnvName> =
  SpecOf<N> extends { required: true } | { fallback: string } ? never : undefined

type EnvValue<N extends EnvName> = Parsed<N> | Absent<N>
type EnvText<N extends EnvName> = string | Absent<N>

/** The schema as rows, for a page or a document that lists it. */
export const envSchema: readonly (Spec & { name: EnvName })[] = (
  Object.entries(SCHEMA) as [EnvName, Spec][]
).map(([name, spec]) => ({ name, ...spec }))

// ── validators ─────────────────────────────────────────────────────────────

/** What a kind wanted, as the rest of "X is set but is not …". */
export class EnvFormatError extends Error {}

const urlWith =
  (protocols: readonly string[], expected: string) =>
  (raw: string): string => {
    let protocol: string
    try {
      protocol = new URL(raw).protocol
    } catch {
      throw new EnvFormatError(expected)
    }
    if (!protocols.includes(protocol)) throw new EnvFormatError(expected)
    return raw
  }

export const parsers: { [K in Kind]: (raw: string) => KindValue[K] } = {
  string: (raw) => raw,
  url: urlWith(['http:', 'https:'], 'an http(s) URL'),
  dsn: urlWith(['postgres:', 'postgresql:'], 'a postgres:// URL'),
  path: (raw) => {
    if (!raw.startsWith('/')) throw new EnvFormatError('an absolute path')
    return raw
  },
  int: (raw) => {
    const n = Number(raw)
    if (!/^-?\d+$/.test(raw) || !Number.isSafeInteger(n)) {
      throw new EnvFormatError('a whole number')
    }
    return n
  },
  // nix writes "1" and "0". `true` is refused rather than guessed at: the
  // readers that predate this schema compared against "1" and nothing else.
  flag: (raw) => {
    if (raw !== '1' && raw !== '0') throw new EnvFormatError('"1" or "0"')
    return raw === '1'
  },
  list: (raw) =>
    raw
      .split(',')
      .map((s) => s.trim())
      .filter((s) => s !== ''),
}

// ── the accessor ───────────────────────────────────────────────────────────

export class EnvError extends Error {}

type Source = () => Record<string, string | undefined>
type Outcome =
  | { state: 'ok'; raw: string; value: KindValue[Kind] }
  | { state: 'absent' }
  | { state: 'malformed'; expected: string }

const parseWith = <K extends Kind>(kind: K, raw: string): KindValue[K] => parsers[kind](raw)

function inspect(spec: Spec, raw: string | undefined): Outcome {
  // Empty is absent: a nix binding that renders nothing (`grep -m1 … || true`)
  // arrives as `NAME=`, and that is a key nobody minted, not a value.
  if (raw === undefined || raw === '') return { state: 'absent' }
  try {
    return { state: 'ok', raw, value: parseWith(spec.kind, raw) }
  } catch (e) {
    if (e instanceof EnvFormatError) return { state: 'malformed', expected: e.message }
    throw e
  }
}

const missing = (name: EnvName, spec: Spec): string =>
  `${name} is not set, and the app cannot run without it. It is bound by ${spec.source}.`
const malformedRequired = (name: EnvName, expected: string): string =>
  `${name} is set but is not ${expected}, and the app cannot run without it.`
const malformedOptional = (name: EnvName, expected: string, spec: Spec): string =>
  `[env] ${name} is set but is not ${expected}; reading it as ${
    spec.fallback === undefined ? 'unset' : 'its default'
  }.`

type EnvReport = {
  /** Required rows that are missing or malformed, one sentence each. */
  fatal: string[]
  /** Optional rows that are malformed, one line each. */
  warnings: { name: EnvName; line: string }[]
}

export type Env = {
  /** The parsed value. Throws EnvError for a required row it cannot give. */
  get<N extends EnvName>(name: N): EnvValue<N>
  /** The same read, as the string that was bound — what `Ctx.env` hands a loader. */
  text<N extends EnvName>(name: N): EnvText<N>
  /** Every row, checked. Pure: logs nothing and throws nothing. */
  check(): EnvReport
}

/**
 * An accessor over some environment. `warn` is called once per malformed
 * name for as long as `warned` lives.
 */
export function makeEnv(
  source: Source,
  warn: (line: string) => void,
  warned: Set<string> = new Set(),
): Env {
  function read(name: EnvName): { raw: string; value: KindValue[Kind] } | undefined {
    const spec: Spec = SCHEMA[name]
    const got = inspect(spec, source()[name])
    if (got.state === 'ok') return got
    if (spec.required) {
      throw new EnvError(
        got.state === 'absent' ? missing(name, spec) : malformedRequired(name, got.expected),
      )
    }
    if (got.state === 'malformed' && !warned.has(name)) {
      warned.add(name)
      warn(malformedOptional(name, got.expected, spec))
    }
    if (spec.fallback === undefined) return undefined
    return { raw: spec.fallback, value: parseWith(spec.kind, spec.fallback) }
  }

  return {
    get: <N extends EnvName>(name: N) => read(name)?.value as EnvValue<N>,
    text: <N extends EnvName>(name: N) => read(name)?.raw as EnvText<N>,
    check() {
      const report: EnvReport = { fatal: [], warnings: [] }
      for (const { name, ...spec } of envSchema) {
        const got = inspect(spec, source()[name])
        if (got.state === 'ok') continue
        if (spec.required) {
          report.fatal.push(
            got.state === 'absent' ? missing(name, spec) : malformedRequired(name, got.expected),
          )
        } else if (got.state === 'malformed') {
          report.warnings.push({ name, line: malformedOptional(name, got.expected, spec) })
        }
      }
      return report
    },
  }
}

// Vite re-evaluates this file on every save while the process lives on, so
// what has been said already sits on globalThis: a save must not repeat the
// report, nor a warning.
const SLOT = '__daedalusEnv_v1'
type Slot = { warned: Set<string>; reported: boolean }
const g = globalThis as unknown as Record<string, unknown>
const isSlot = (v: unknown): v is Slot =>
  typeof v === 'object' && v !== null && 'warned' in v && v.warned instanceof Set
const slot: Slot = isSlot(g[SLOT]) ? g[SLOT] : { warned: new Set(), reported: false }
g[SLOT] = slot

export const env: Env = makeEnv(
  () => process.env,
  (line) => console.warn(line),
  slot.warned,
)

/**
 * The startup pass: every malformed optional row warned about once, and a
 * required row that cannot be given thrown as one EnvError. Once per process.
 */
export function reportEnvOnce(): void {
  if (slot.reported) return
  const { fatal, warnings } = env.check()
  for (const { name, line } of warnings) {
    if (slot.warned.has(name)) continue
    slot.warned.add(name)
    console.warn(line)
  }
  if (fatal.length > 0) throw new EnvError(fatal.join(' '))
  slot.reported = true
}
