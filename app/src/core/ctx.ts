import { join } from 'node:path'
import { readSnapshot, type SnapshotResult } from '../host/contract/snapshot'
import { type Hosts, makeHosts } from '../host/hosts'
import { key } from '../host/keys'
import { lokiEntries, lokiLatest } from '../host/loki'
import { bool, type Decoder, recordOf } from '../lib/contract/decode'
import { getJson } from '../lib/http'

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

export type Ctx = {
  /** Non-secret configuration bound by the NixOS module. Undefined when unset or empty. */
  env: (name: string) => string | undefined
  /** A service credential rendered by nix (the DASH_* set). '' when absent. */
  secret: (name: string) => string
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
  http: { getJson: typeof getJson }
  loki: { latest: typeof lokiLatest; entries: typeof lokiEntries }
  /** Where a published service lives, and how a container reaches the host. */
  hosts: Hosts
  /** The box's nix modules. `enabled` answers true for anything the export does not deny. */
  modules: { enabled: (nixModule: string) => boolean }
}

export async function makeCtx(): Promise<Ctx> {
  const { readSetting, writeSetting, deleteSetting } = await import('../lib/repo/settings')
  const exportDir = process.env.EXPORT_DIR ?? '/export'
  const [hosts, modules] = await Promise.all([
    makeHosts(),
    readSnapshot({
      path: join(exportDir, MODULES_EXPORT),
      decoder: recordOf(bool),
      fallback: {} as Record<string, boolean>,
    }),
  ])
  return {
    env: (name) => {
      const v = process.env[name]
      return v === undefined || v === '' ? undefined : v
    },
    secret: key,
    exportPath: (file) => join(exportDir, file),
    snapshot: readSnapshot,
    store: { read: readSetting, write: writeSetting, delete: deleteSetting },
    http: { getJson },
    loki: { latest: lokiLatest, entries: lokiEntries },
    hosts,
    modules: {
      enabled: (id) => (modules.available ? (modules.data[id] ?? true) : true),
    },
  }
}
