import type { Ctx } from '../../../core/ctx'
import type { SnapshotResult } from '../../../host/contract/snapshot'
import {
  arrayOf,
  bool,
  DecodeError,
  type Decoder,
  int,
  nullable,
  num,
  obj,
  oneOf,
  optional,
  str,
} from '../../../lib/contract/decode'

// Proton Mail Bridge, as its supervisor reports it.
//
// Bridge runs headless under a supervisor that holds its event stream and
// writes one JSON document (schema v1) to a directory the host mounts here
// read-only: the version, connectivity, each account's state, storage and
// sync, and the last thirty events. Never a password — there is none in the
// file, and nothing on this page asks for one. The supervisor replaces the
// file by rename on every change and at least every 30 s while Bridge runs,
// so a document older than REPORTING_MS is a container that stopped: the
// file outlives it, and its last word must not pass for a current one.

export type AccountState = 'connected' | 'locked' | 'signed-out'
export type SyncState = 'syncing' | 'idle'

export type BridgeAccount = {
  id: string
  username: string
  state: AccountState
  /** Each address its own mailbox, rather than one combined. */
  splitMode: boolean
  addresses: string[]
  usedBytes: number
  totalBytes: number
  sync: {
    state: SyncState
    /** 0..1. */
    progress: number
    elapsedMs: number
    /** Bridge's own estimate. */
    remainingMs: number
    startedAt: string | null
    /**
     * Null while idle means no sync has run since Bridge started — which,
     * for a connected account, is up to date: Bridge resumes an unfinished
     * sync at start and would report it as syncing.
     */
    finishedAt: string | null
  }
}

/**
 * One thing that happened, newest first. `kind` is kept as the supervisor
 * wrote it rather than refused when unknown: a kind added later is one event
 * row this page labels plainly, not a page that stops reading the file.
 */
export type BridgeEvent = { at: string; kind: string; detail: string }

export type BridgeStatus = {
  schemaVersion: 1
  /** `starting` until Bridge's gRPC service answers and the accounts are read. */
  phase: 'starting' | 'running'
  startedAt: string
  updatedAt: string
  version: string
  /** Proton's API reachable. Null: Bridge has not said yet. */
  online: boolean | null
  /** Port 0 until Bridge has reported its settings. `ssl` false is STARTTLS. */
  imap: { port: number; ssl: boolean }
  smtp: { port: number; ssl: boolean }
  users: BridgeAccount[]
  events: BridgeEvent[]
}

export type BridgeReport = {
  /** The last document Bridge wrote. Null when there is none to read. */
  status: BridgeStatus | null
  /**
   * Written within REPORTING_MS. False: the file is missing, unreadable or
   * old, which means the container (or its supervisor) is not running.
   */
  reporting: boolean
  /** Why the document could not be read: malformed, or another schema version. */
  error: string | null
}

/** Four missed heartbeats. */
export const REPORTING_MS = 2 * 60_000

const schemaV1: Decoder<1> = (v, p) => {
  if (v !== 1) throw new DecodeError(p, `expected schema version 1, got ${JSON.stringify(v)}`)
  return 1
}

/** Go writes an empty slice it never made as `null`. */
const list =
  <T>(d: Decoder<T>): Decoder<T[]> =>
  (v, p) =>
    v === null ? [] : arrayOf(d)(v, p)

const endpoint = obj({ port: int, ssl: bool })

const account: Decoder<BridgeAccount> = obj({
  id: str,
  username: str,
  state: oneOf<AccountState>({ connected: true, locked: true, 'signed-out': true }),
  splitMode: bool,
  addresses: list(str),
  usedBytes: num,
  totalBytes: num,
  sync: obj({
    state: oneOf<SyncState>({ syncing: true, idle: true }),
    progress: num,
    elapsedMs: num,
    remainingMs: num,
    startedAt: nullable(str),
    finishedAt: nullable(str),
  }),
})

/** The version comes first, so a v2 document fails on its version and not on a field it moved. */
export const bridgeStatus: Decoder<BridgeStatus> = obj({
  schemaVersion: schemaV1,
  phase: oneOf<BridgeStatus['phase']>({ starting: true, running: true }),
  startedAt: str,
  updatedAt: str,
  version: str,
  online: nullable(bool),
  imap: endpoint,
  smtp: endpoint,
  users: list(account),
  events: list(obj({ at: str, kind: str, detail: optional(str, '') })),
})

/** What a snapshot read of the file says, at `now`. */
export function reportOf(r: SnapshotResult<BridgeStatus | null>, now: number): BridgeReport {
  const status = r.available ? r.data : null
  if (status === null) return { status: null, reporting: false, error: r.error }
  // The document's own clock, not the file's mtime: it is the supervisor
  // saying "I was alive at", which is the claim being tested.
  const at = Date.parse(status.updatedAt)
  return { status, reporting: Number.isFinite(at) && now - at <= REPORTING_MS, error: null }
}

/** The status file, read now. Unbound path: the box mounts none, so nothing reports. */
export async function readBridge(ctx: Pick<Ctx, 'env' | 'snapshot'>): Promise<BridgeReport> {
  const path = ctx.env('PROTON_BRIDGE_STATUS_FILE')
  if (path === undefined) return { status: null, reporting: false, error: null }
  const r = await ctx.snapshot({ path, decoder: nullable(bridgeStatus), fallback: null })
  return reportOf(r, Date.now())
}
