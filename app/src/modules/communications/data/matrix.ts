import type { Ctx } from '../../../core/ctx'
import type { SnapshotResult } from '../../../host/contract/snapshot'
import { type AppResources, containerResources } from '../../../lib/apps/metrics'
import {
  arrayOf,
  bool,
  DecodeError,
  type Decoder,
  int,
  nullable,
  obj,
  optional,
  str,
} from '../../../lib/contract/decode'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { releases } from '../releases'

// Communications › the Matrix tab: the box's private homeserver and the
// bridges it carries, as the stack's helper reports them.
//
// Nothing here can ask Synapse or a bridge anything: both listen on the
// loopback of a namespace the control plane is not in. A helper inside it
// (matrix-status) writes one JSON document every 30 s to a directory the host
// mounts here read-only: whether the homeserver answers and its version,
// whether the operator's Matrix account signs in, and each WhatsApp login's
// state as the bridge reports it. It names the linked phone, never a secret.
// A document older than REPORTING_MS is a helper that stopped: its last word
// must not pass for a current one.

/** The bridge's own words for a login (bridgev2 status.BridgeStateEvent). */
export type LoginState =
  | 'CONNECTING'
  | 'BACKFILLING'
  | 'CONNECTED'
  | 'TRANSIENT_DISCONNECT'
  | 'BAD_CREDENTIALS'
  | 'UNKNOWN_ERROR'
  | 'LOGGED_OUT'
  | (string & {})

export type BridgeLogin = {
  id: string
  name: string
  phone: string
  state: LoginState
  /** A machine code, e.g. `wa-phone-offline`. Empty when none. */
  error: string
  /** The bridge's sentence for it. */
  message: string
  /** When the state began, unix seconds. Null: not said. */
  since: number | null
}

export type MatrixStatus = {
  schema: 1
  generatedAt: string
  homeserver: { serverName: string; healthy: boolean; version: string; error: string }
  operator: { mxid: string; signedIn: boolean; joinedRooms: number | null; error: string }
  whatsapp: {
    ready: boolean
    bot: string
    commandPrefix: string
    logins: BridgeLogin[]
    error: string
  }
}

export type MatrixReport = {
  status: MatrixStatus | null
  /** Written within REPORTING_MS. False: missing, unreadable or old — the helper is not running. */
  reporting: boolean
  error: string | null
}

/** Four missed heartbeats. */
export const REPORTING_MS = 2 * 60_000

const schemaV1: Decoder<1> = (v, p) => {
  if (v !== 1) throw new DecodeError(p, `expected schema 1, got ${JSON.stringify(v)}`)
  return 1
}

/** Go writes an empty slice it never made as `null`. */
const list =
  <T>(d: Decoder<T>): Decoder<T[]> =>
  (v, p) =>
    v === null || v === undefined ? [] : arrayOf(d)(v, p)

const login: Decoder<BridgeLogin> = obj({
  id: str,
  name: optional(str, ''),
  phone: optional(str, ''),
  state: str,
  error: optional(str, ''),
  message: optional(str, ''),
  since: optional(nullable(int), null),
})

/** The version comes first, so another version fails on its version and not on a field it moved. */
export const matrixStatus: Decoder<MatrixStatus> = obj({
  schema: schemaV1,
  generatedAt: str,
  homeserver: obj({
    serverName: str,
    healthy: bool,
    version: optional(str, ''),
    error: optional(str, ''),
  }),
  operator: obj({
    mxid: str,
    signedIn: bool,
    joinedRooms: optional(nullable(int), null),
    error: optional(str, ''),
  }),
  whatsapp: obj({
    ready: bool,
    bot: optional(str, ''),
    commandPrefix: optional(str, ''),
    logins: list(login),
    error: optional(str, ''),
  }),
})

/** What a snapshot read of the file says, at `now`. */
export function reportOf(r: SnapshotResult<MatrixStatus | null>, now: number): MatrixReport {
  const status = r.available ? r.data : null
  if (status === null) return { status: null, reporting: false, error: r.error }
  const at = Date.parse(status.generatedAt)
  return { status, reporting: Number.isFinite(at) && now - at <= REPORTING_MS, error: null }
}

/** The status file, read now. Unbound path: the box mounts none, so nothing reports. */
export async function readMatrix(ctx: Pick<Ctx, 'env' | 'snapshot'>): Promise<MatrixReport> {
  const path = ctx.env('MATRIX_STATUS_FILE')
  if (path === undefined) return { status: null, reporting: false, error: null }
  const r = await ctx.snapshot({ path, decoder: nullable(matrixStatus), fallback: null })
  return reportOf(r, Date.now())
}

export type MatrixData = {
  report: MatrixReport
  synapse: { gap: VersionGap; resources: AppResources }
  whatsapp: { gap: VersionGap; resources: AppResources }
}

export async function loadMatrix(ctx: Ctx): Promise<MatrixData> {
  const report = await readMatrix(ctx)
  const reported = report.status?.homeserver.version ?? ''
  const [synapseGap, whatsappGap, synapseRes, whatsappRes] = await Promise.all([
    versionGap(releases['matrix-synapse'].repo, reported === '' ? null : reported),
    versionGap(releases['mautrix-whatsapp'].repo, ctx.env('MAUTRIX_WHATSAPP_VERSION') ?? null),
    containerResources(ctx, 'matrix-synapse'),
    containerResources(ctx, 'matrix-whatsapp'),
  ])
  return {
    report,
    synapse: { gap: synapseGap, resources: synapseRes },
    whatsapp: { gap: whatsappGap, resources: whatsappRes },
  }
}
