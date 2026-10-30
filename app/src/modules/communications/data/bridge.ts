import type { Ctx } from '../../../core/ctx'
import type { SnapshotResult } from '../../../host/contract/snapshot'
import {
  absent,
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
// Bridge runs headless under a supervisor that holds its event stream, reads
// each account's mailbox over IMAP, and writes one JSON document (schema v2)
// to a directory the host mounts here read-only: the version, connectivity,
// Bridge's settings, the size of its stores, each account's state, storage,
// sync and mailbox, and the last thirty events. Never a password — there is
// none in the file. The supervisor replaces the file by rename on every
// change and at least every 30 s while Bridge runs, so a document older than
// REPORTING_MS is a container that stopped: the file outlives it, and its
// last word must not pass for a current one.

export type AccountState = 'connected' | 'locked' | 'signed-out'
export type SyncState = 'syncing' | 'idle'
export type FolderKind = 'system' | 'folder' | 'label'

export type BridgeFolder = { name: string; kind: FolderKind; messages: number; unseen: number }

/** One day of All Mail by arrival, the box's local day. `sent`: from one of the account's addresses. */
export type MailDay = { day: string; received: number; sent: number }

export type MailSender = { address: string; name: string; count: number }

export type MailMessage = {
  date: string
  fromName: string
  fromAddress: string
  subject: string
  unread: boolean
  flagged: boolean
  attachments: boolean
}

/** What the supervisor last read of an account over IMAP. */
export type Mailbox = {
  readAt: string
  /** The last read failed; everything else is from the last good one (empty if none). */
  error: string | null
  folders: BridgeFolder[]
  /** Thirty days, oldest first. */
  days: MailDay[]
  /** More than the supervisor counts in one read arrived in the window: the counts are partial. */
  windowCapped: boolean
  /** Received in the window, at most ten, by count. */
  topSenders: MailSender[]
  /** INBOX, newest first, at most fifteen. */
  recent: MailMessage[]
}

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
    finishedAt: string | null
    /** The last completed sync this supervisor saw. */
    lastDurationMs: number | null
  }
  /** Null until the supervisor's first IMAP read of the account. */
  mailbox: Mailbox | null
}

/**
 * Bridge's own settings, each absent when Bridge did not answer for it: an
 * absent one is not drawn.
 */
export type BridgeSettings = {
  keychain?: string
  allMailVisible?: boolean
  alternativeRouting?: boolean
  telemetryDisabled?: boolean
  automaticUpdates?: boolean
  earlyAccess?: boolean
}

/**
 * One thing that happened, newest first. `kind` is kept as the supervisor
 * wrote it rather than refused when unknown: a kind added later is one event
 * row this page labels plainly, not a page that stops reading the file.
 */
export type BridgeEvent = { at: string; kind: string; detail: string }

export type BridgeStatus = {
  schemaVersion: 2
  /** `starting` until Bridge's gRPC service answers and the accounts are read. */
  phase: 'starting' | 'running'
  startedAt: string
  updatedAt: string
  version: string
  /** Bridge's own verdict: its IMAP listener is open only while Proton's API answers. Null: not said yet. */
  online: boolean | null
  /** Port 0 until Bridge has reported its settings. `ssl` false is STARTTLS. */
  imap: { port: number; ssl: boolean }
  smtp: { port: number; ssl: boolean }
  settings: BridgeSettings
  /** The message store and the search index on disk. Null until first measured. */
  disk: { messageStoreBytes: number; indexBytes: number; measuredAt: string } | null
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

const schemaV2: Decoder<2> = (v, p) => {
  if (v !== 2) throw new DecodeError(p, `expected schema version 2, got ${JSON.stringify(v)}`)
  return 2
}

/** Go writes an empty slice it never made as `null`. */
const list =
  <T>(d: Decoder<T>): Decoder<T[]> =>
  (v, p) =>
    v === null || v === undefined ? [] : arrayOf(d)(v, p)

const SETTINGS = obj({
  keychain: absent(str),
  allMailVisible: absent(bool),
  alternativeRouting: absent(bool),
  telemetryDisabled: absent(bool),
  automaticUpdates: absent(bool),
  earlyAccess: absent(bool),
})

/** Drops the keys the decoder left `undefined`, so an absent setting is absent, not a key. */
const settings: Decoder<BridgeSettings> = (v, p) => {
  if (v === undefined || v === null) return {}
  const s = SETTINGS(v, p)
  return Object.fromEntries(Object.entries(s).filter(([, x]) => x !== undefined)) as BridgeSettings
}

const endpoint = obj({ port: int, ssl: bool })

const mailbox: Decoder<Mailbox> = obj({
  readAt: str,
  error: optional(nullable(str), null),
  folders: list(
    obj({
      name: str,
      kind: oneOf<FolderKind>({ system: true, folder: true, label: true }),
      messages: int,
      unseen: int,
    }),
  ),
  days: list(obj({ day: str, received: int, sent: int })),
  windowCapped: optional(bool, false),
  topSenders: list(obj({ address: str, name: optional(str, ''), count: int })),
  recent: list(
    obj({
      date: str,
      fromName: optional(str, ''),
      fromAddress: optional(str, ''),
      subject: optional(str, ''),
      unread: bool,
      flagged: bool,
      attachments: bool,
    }),
  ),
})

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
    lastDurationMs: optional(nullable(num), null),
  }),
  mailbox: optional(nullable(mailbox), null),
})

/** The version comes first, so another version fails on its version and not on a field it moved. */
export const bridgeStatus: Decoder<BridgeStatus> = obj({
  schemaVersion: schemaV2,
  phase: oneOf<BridgeStatus['phase']>({ starting: true, running: true }),
  startedAt: str,
  updatedAt: str,
  version: str,
  online: nullable(bool),
  imap: endpoint,
  smtp: endpoint,
  settings,
  disk: optional(nullable(obj({ messageStoreBytes: num, indexBytes: num, measuredAt: str })), null),
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
