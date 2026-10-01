import type { Ctx } from '../../core/ctx'
import {
  type ModelFigures,
  type ProviderBackend,
  type ProviderDownload,
  type ProviderHealth,
  type ProviderKind,
  type ProviderModel,
  SUBGEN_MODEL,
} from '../../lib/providers/kinds'
import type { NodeProviderReport, NodeProvidersAnswer } from '../controller/wire'

// Reading a provider: its catalog, its health and the page's detail.
//
// A NODE's provider is never dialled from here. The node's own agent reads
// it on loopback and pushes what it found up its link; the controller keeps
// the last document and this reads it (`nodes.providers`), so a provider
// answers the box exactly as it answers its own machine, and what the box
// knows about it is as fresh as the agent's last read — a minute, ten
// seconds while a download runs, at once after a residency verb. Only the
// gateway's routes still dial the machine (host/providers/fleet.ts `base`).
//
// The box's own subgen is a container here, reached through the host
// gateway alias, and read directly.
//
// A provider that cannot be read is `reachable: false` with the last catalog
// its machine reported, so a machine asleep keeps its rows on the page and
// its routes in the gateway (host/gateway-sync.ts keeps what belongs to a
// provider that did not answer) — and so does a machine whose agent has not
// reported yet.

/** What the page shows beyond the catalog: downloads, runtimes, per-model figures. */
export type ProviderDetail = {
  downloads: ProviderDownload[]
  backends: ProviderBackend[]
  /** By the provider's model id. Absent means "never served since it started". */
  figures: Record<string, ModelFigures>
}

export const NO_DETAIL: ProviderDetail = { downloads: [], backends: [], figures: {} }

export type ProviderReading = {
  kind: ProviderKind
  base: string
  reachable: boolean
  /**
   * The machine has pushed a providers document. False until its agent has
   * read them: the page says "no report yet"
   * rather than "not answering". Always true for this box's own.
   */
  reported: boolean
  /** What the agent found, for a node: running or only installed, and its version. */
  presence: { running: boolean; version: string | null } | null
  health: ProviderHealth
  models: ProviderModel[]
  detail: ProviderDetail
  /** Why it is unreachable, or what part of the read failed, in a sentence; or null. */
  error: string | null
  /** When it was read, ms since the epoch (the agent's clock, for a node). */
  readAt: number
  /** The residency verbs' outcomes on the machine, newest last. */
  actions: NodeProviderReport['actions']
}

/**
 * A report older than this, from a machine that is connected, is a reader
 * that stopped: the link pushes the document every minute even unchanged.
 */
const STALE_MS = 5 * 60_000

const DOWN: ProviderHealth = { ok: false, version: null, loaded: [] }

function silent(
  kind: ProviderKind,
  base: string,
  error: string,
  now: number,
  last: NodeProviderReport | undefined,
  reported: boolean,
): ProviderReading {
  return {
    kind,
    base,
    reachable: false,
    reported,
    presence: last === undefined ? null : { running: last.running, version: last.version },
    health: DOWN,
    models: last?.models ?? [],
    detail: NO_DETAIL,
    error,
    readAt: now,
    actions: last?.actions ?? [],
  }
}

/**
 * A node's provider of `kind`, from what the controller holds for the
 * machine: its answer, or the error asking it failed with. Pure.
 */
export function nodeReading(
  kind: ProviderKind,
  base: string,
  answer: NodeProvidersAnswer | Error,
  now: number = Date.now(),
): ProviderReading {
  if (answer instanceof Error) {
    return silent(
      kind,
      base,
      `the controller did not answer: ${answer.message}`,
      now,
      undefined,
      false,
    )
  }
  if (answer.providers === null) {
    return silent(kind, base, 'no report from this machine yet', now, undefined, false)
  }
  const r = answer.providers.find((p) => p.kind === kind)
  const at = answer.receivedAt === null ? Number.NaN : Date.parse(answer.receivedAt)
  if (r === undefined) {
    return silent(kind, base, 'the agent finds none on this machine', now, undefined, true)
  }
  if (!answer.connected) {
    return silent(kind, base, 'the machine is not connected; this is its last report', now, r, true)
  }
  if (Number.isFinite(at) && now - at > STALE_MS) {
    const min = Math.round((now - at) / 60_000)
    return silent(kind, base, `its agent has not reported for ${String(min)} minutes`, now, r, true)
  }
  if (!r.running) {
    return silent(kind, base, r.error ?? 'installed, not running', now, r, true)
  }
  const readAt = Date.parse(r.readAt)
  return {
    kind,
    base,
    reachable: true,
    reported: true,
    presence: { running: true, version: r.version },
    health: { ok: r.healthy, version: r.version, loaded: r.loaded },
    models: r.models,
    detail: { downloads: r.downloads, backends: r.backends, figures: r.figures },
    error: r.error,
    readAt: Number.isFinite(readAt) ? readAt : now,
    actions: r.actions,
  }
}

/** This box's subgen, from its own `/status`: one model, no catalog. */
export async function readSubgen(
  ctx: Ctx,
  base: string,
  now: number = Date.now(),
): Promise<ProviderReading> {
  const status = await ctx.http
    .getJson<unknown>(`${base.replace(/\/+$/, '')}/status`)
    .catch(() => null)
  const answered = status !== null
  return {
    kind: 'subgen',
    base,
    reachable: answered,
    reported: true,
    presence: null,
    health: answered
      ? {
          ok: true,
          version: null,
          loaded: [{ id: SUBGEN_MODEL.id, device: null, maxContext: null, pinned: true }],
        }
      : DOWN,
    models: [SUBGEN_MODEL],
    detail: NO_DETAIL,
    error: answered ? null : 'did not answer /status',
    readAt: now,
    actions: [],
  }
}
