import { join } from 'node:path'
import type { Decoder } from '../lib/contract/decode'
import { readSnapshot, type SnapshotResult } from '../lib/contract/snapshot'
import { getJson } from '../lib/http'
import { key } from '../lib/keys'
import { lokiEntries, lokiLatest } from '../lib/loki'

// The capability set a reader is handed instead of reaching for process.env.
//
// Today one consumer, core/settings. From the module system on (plan, Phase
// 10) every module loader receives one of these and nothing else: no
// `process.env` in a loader, no direct database import, no ad-hoc file read.
// The shape is decided now, while there is one consumer to get it right
// against, so that code lands in its final home rather than being moved
// there later.
//
// Everything here is server-only — the snapshot reader touches the
// filesystem and the store is Postgres — so this module must only ever be
// imported dynamically from a server function, like lib/repo/*.

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
  /** The preferences store. Nothing in it is rebuild-relevant — see lib/schema.ts. */
  store: {
    read<T>(key: string, guard: (v: unknown) => v is T): Promise<T | undefined>
    write(key: string, value: unknown): Promise<void>
  }
  http: { getJson: typeof getJson }
  loki: { latest: typeof lokiLatest; entries: typeof lokiEntries }
}

export async function makeCtx(): Promise<Ctx> {
  const { readSetting, writeSetting } = await import('../lib/repo/settings')
  const exportDir = process.env.EXPORT_DIR ?? '/export'
  return {
    env: (name) => {
      const v = process.env[name]
      return v === undefined || v === '' ? undefined : v
    },
    secret: key,
    exportPath: (file) => join(exportDir, file),
    snapshot: readSnapshot,
    store: { read: readSetting, write: writeSetting },
    http: { getJson },
    loki: { latest: lokiLatest, entries: lokiEntries },
  }
}
