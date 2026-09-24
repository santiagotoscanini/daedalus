import { join } from 'node:path'
import { readSnapshot, type SnapshotResult } from '../host/contract/snapshot'
import { type ConfigName, env, type SecretName } from '../host/env'
import { type Hosts, makeHosts } from '../host/hosts'
import { key } from '../host/keys'
import {
  LOKI,
  lokiEntries,
  lokiLatest,
  lokiScalar,
  lokiSeries,
  lokiStreams,
  lokiStreamsOrNull,
  lokiVector,
} from '../host/loki'
import {
  PROM,
  promBars,
  promEscape,
  promMatrix,
  promPoints,
  promQuote,
  promScalar,
  promScalars,
  promSeries,
  promVector,
} from '../host/prom'
import { readSite } from '../host/site'
import { bool, type Decoder, recordOf } from '../lib/contract/decode'
import { getJson, getText } from '../lib/http'
import type { ModuleState } from '../lib/modules/active'
import type { Site } from '../lib/site'
import type { GhResult } from './github-app'

// The capability set a reader is handed instead of reaching for process.env.
//
// Every module loader (src/modules/*/data) receives one of these and nothing
// else: no `process.env` in a loader, no direct database import, no ad-hoc
// file read — host/boundary.test.ts refuses a `process.env` anywhere under
// src/modules. core/settings reads through one too.
//
// Everything here is server-only — the snapshot reader touches the
// filesystem and the store is Postgres — so this module must only ever be
// imported dynamically from a server function, like lib/repo/*.

/**
 * Which nix modules the box runs, as `/export/modules.json` publishes them:
 * `fleet.modules.<id>.enable`, one boolean per id. Until the box publishes
 * the file, every module counts as enabled — a missing export must not empty
 * the rail — and so does an id the file does not mention.
 */
const MODULES_EXPORT = 'modules.json'

export type Gateway = { baseUrl: string; apiKey: string }

export type Ctx = {
  /**
   * Non-secret configuration bound by the NixOS module, by a name host/env.ts
   * declares. Undefined when unset, empty, or not the shape its row asks for.
   */
  env: (name: ConfigName) => string | undefined
  /** A service credential rendered by nix (the DASH_* set), by its row's name less the prefix. '' when absent. */
  secret: (name: SecretName) => string
  /** Where an export domain lives: `exportPath('site.json')`. */
  exportPath: (file: string) => string
  /** A published export domain or host snapshot, decoded, with its staleness. */
  snapshot: <T>(opts: {
    path: string
    decoder: Decoder<T>
    fallback: T
    acceptVersions?: number[]
    maxAgeMs?: number
  }) => Promise<SnapshotResult<T>>
  /** The preferences store. Nothing in it is rebuild-relevant — see host/schema.ts. */
  store: {
    read<T>(key: string, guard: (v: unknown) => v is T): Promise<T | undefined>
    write(key: string, value: unknown): Promise<void>
    /** Drop the key. The way to unset: the column refuses null. */
    delete(key: string): Promise<void>
  }
  http: { getJson: typeof getJson; getText: typeof getText }
  /**
   * The Prometheus client, the only way a module reads PromQL. `url` is
   * undefined on a box without the monitoring bridge, and every read answers
   * null or [] rather than throwing, per lib/http.ts.
   */
  prom: {
    url: typeof PROM
    escape: typeof promEscape
    quote: typeof promQuote
    vector: typeof promVector
    scalar: typeof promScalar
    scalars: typeof promScalars
    matrix: typeof promMatrix
    series: typeof promSeries
    points: typeof promPoints
    bars: typeof promBars
  }
  /** The Loki client, same rule; one patient attempt per query (host/loki.ts). */
  loki: {
    url: typeof LOKI
    scalar: typeof lokiScalar
    vector: typeof lokiVector
    series: typeof lokiSeries
    streams: typeof lokiStreams
    streamsOrNull: typeof lokiStreamsOrNull
    latest: typeof lokiLatest
    entries: typeof lokiEntries
  }
  /**
   * GitHub, two ways. `app` speaks as the box's App installation and answers
   * a 403 for anything the App was not granted; `anon` sends no token, which
   * is enough for a public repository's Actions and costs the shared
   * unauthenticated budget (60 calls an hour per address). Both are paths,
   * never URLs, and never throw (core/github-app.ts).
   */
  github: {
    app: <T = unknown>(path: string, init?: RequestInit) => Promise<GhResult<T>>
    anon: <T = unknown>(path: string) => Promise<GhResult<T>>
  }
  /**
   * The LLM gateway, or null on a box without one. Both halves or neither: a
   * base URL with no key is a tab of 401s read as zeroes.
   */
  gateway: Gateway | null
  /** Where a published service lives, and how a container reaches the host. */
  hosts: Hosts
  /** The box's identity — domain, owner, registry, Grafana — as this process's env binds it. */
  site: Site
  /**
   * The box's nix modules. `enabled` answers true for anything the export
   * does not deny; `state` says which of the three a tab's page draws:
   * `on`, `off` (declared and switched off — the tab stays in the rail,
   * greyed, with its switch), or `absent` (this box does not import it — the
   * tab is not offered). Until the export exists everything reads as `on`.
   */
  modules: {
    enabled: (nixModule: string) => boolean
    state: (nixModule: string) => ModuleState
  }
}

/** LiteLLM as the environment binds it: LITELLM_BASE_URL and LITELLM_API_KEY, both optional. */
export const gatewayOf = (
  baseUrl: string | undefined,
  apiKey: string | undefined,
): Gateway | null => (baseUrl === undefined || apiKey === undefined ? null : { baseUrl, apiKey })

export async function makeCtx(): Promise<Ctx> {
  const { readSetting, writeSetting, deleteSetting } = await import('../lib/repo/settings')
  const exportDir = env.get('EXPORT_DIR')
  const [hosts, modules] = await Promise.all([
    makeHosts(),
    readSnapshot({
      path: join(exportDir, MODULES_EXPORT),
      decoder: recordOf(bool),
      fallback: {} as Record<string, boolean>,
    }),
  ])
  const ctx: Ctx = {
    env: (name) => env.text(name),
    secret: key,
    gateway: gatewayOf(env.get('LITELLM_BASE_URL'), env.get('LITELLM_API_KEY')),
    exportPath: (file) => join(exportDir, file),
    snapshot: readSnapshot,
    store: { read: readSetting, write: writeSetting, delete: deleteSetting },
    http: { getJson, getText },
    prom: {
      url: PROM,
      escape: promEscape,
      quote: promQuote,
      vector: promVector,
      scalar: promScalar,
      scalars: promScalars,
      matrix: promMatrix,
      series: promSeries,
      points: promPoints,
      bars: promBars,
    },
    loki: {
      url: LOKI,
      scalar: lokiScalar,
      vector: lokiVector,
      series: lokiSeries,
      streams: lokiStreams,
      streamsOrNull: lokiStreamsOrNull,
      latest: lokiLatest,
      entries: lokiEntries,
    },
    // Lazy on purpose: core/github-app.ts names this type, and a static
    // import here would be a cycle.
    github: {
      app: (path, init) => import('./github-app').then((m) => m.ghApp(ctx, path, init)),
      anon: (path) => import('./github-app').then((m) => m.ghAnon(path)),
    },
    hosts,
    site: readSite(),
    modules: {
      enabled: (id) => (modules.available ? (modules.data[id] ?? true) : true),
      state: (id) =>
        !modules.available
          ? 'on'
          : modules.data[id] === undefined
            ? 'absent'
            : modules.data[id]
              ? 'on'
              : 'off',
    },
  }
  return ctx
}
