import { DASH, since } from '../../../format'
import { getJson } from '../../../http'
import { key } from '../../../keys'
import { type VersionGap, versionGap } from '../../github'
import { DAYS } from './shared'

/**
 * One workflow: what it is, and what its executions did.
 *
 * The two halves come from two endpoints, and the union is the point. The
 * workflow list alone cannot say the nightly digest has not fired since
 * Sunday; the execution list alone cannot say a workflow is switched on and
 * has never fired at all. Each of those is a fault, and each is invisible to
 * the other endpoint.
 */
type N8nFlow = {
  id: string
  /** Null only for a workflow that ran and has since been deleted. */
  name: string | null
  /** Null when the workflow no longer exists. */
  active: boolean | null
  runs: number
  failed: number
  /** Median wall-clock of a finished run. */
  medianMs: number | null
  /** Typical gap between starts, once there are enough runs to say. */
  everyMs: number | null
  /** Words, computed here — see the note on hydration below. */
  ago: string
  /**
   * Ran on a cadence, and has since missed it.
   *
   * The one thing on this page that cannot be read off any single row: a
   * workflow that stops firing leaves no error, no failed run and no log line.
   * It just goes quiet, and the only evidence is that its own rhythm broke.
   */
  stalled: boolean
  /**
   * Edited since it was last published.
   *
   * `versionId` is the draft, `activeVersionId` is what a schedule actually
   * runs. They diverge the moment somebody edits a workflow without
   * publishing, and the symptom is "I changed it and nothing happened" — the
   * runs keep succeeding, against the old version.
   */
  unpublished: boolean
}

export type N8nData = {
  version: string | null
  gap: VersionGap
  /** Every day of the window, oldest first — including the empty ones. */
  daily: { date: string; runs: number; failed: number }[]
  window: { days: number; runs: number; failed: number; running: number; medianMs: number | null }
  /** Busiest first. */
  flows: N8nFlow[]
  /**
   * The failures themselves, newest first.
   *
   * Few enough to name — one in a fortnight here — which is the whole reason
   * this is a list and the rejected keys on the gateway tab are a count.
   */
  failures: {
    name: string
    /**
     * Computed here rather than in the component on purpose: a relative time
     * derived from the client's clock renders differently on the server and on
     * hydration whenever the render straddles a boundary, which React reports
     * as a hydration mismatch.
     */
    ago: string
  }[]
  /** True when there were more executions than this fetched. */
  partial: boolean
  /** Archived workflows, which are excluded from `flows` entirely. */
  archived: number
  /** Set when the executions API refused, which leaves the page with nothing. */
  note: string | null
  /** Set when the workflow list refused, which costs names and liveness. */
  nameNote: string | null
}

// ── n8n ────────────────────────────────────────────────────────────────────

type Execution = {
  workflowId: string
  status: string
  startedAt: string
  stoppedAt?: string | null
}

/** n8n's page cap is 250; four pages is a fortnight of this box several times over. */
const EXEC_PAGES = 4

/**
 * Every execution n8n still holds, up to a bound.
 *
 * Paged because the interesting figures here — a per-day column, a per-workflow
 * median, a cadence — are all aggregates, and an aggregate over the first page
 * is not an aggregate. `partial` says when the bound was hit rather than
 * letting a truncated window pass for a complete one.
 */
async function listExecutions(
  base: string,
  auth: RequestInit,
): Promise<{ rows: Execution[]; refused: boolean; partial: boolean }> {
  const rows: Execution[] = []
  let cursor: string | null = null

  for (let page = 0; page < EXEC_PAGES; page++) {
    // Annotated and hoisted: inline, the URL's type would depend on `cursor`'s
    // narrowing, which depends on the assignment below it, which depends on
    // this call — a cycle TypeScript refuses to resolve.
    const next: string = cursor === null ? '' : `&cursor=${encodeURIComponent(cursor)}`
    const body = await getJson<{ data?: Execution[]; nextCursor?: string | null }>(
      `${base}/api/v1/executions?limit=250${next}`,
      auth,
    )
    // A refusal on the first page is the key; on a later one it is a partial
    // answer, and the rows already in hand are still worth drawing.
    if (body === null) return { rows, refused: page === 0, partial: page > 0 }
    rows.push(...(body.data ?? []))
    cursor = body.nextCursor ?? null
    if (cursor === null) return { rows, refused: false, partial: false }
  }
  return { rows, refused: false, partial: true }
}

/** `YYYY-MM-DD` in the box's timezone, so a column is the day you lived. */
const localDay = (ms: number): string => new Date(ms).toLocaleDateString('en-CA')

function median(xs: number[]): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  return s[Math.floor(s.length / 2)] ?? null
}

const FAILED = new Set(['error', 'crashed'])
const RUNNING = new Set(['running', 'new', 'waiting'])

/**
 * n8n, read from its executions.
 *
 * Built from BOTH endpoints, unioned. Executions carry what actually happened
 * — did it run, did it work, how long it took, on what rhythm — and nothing
 * here runs on a person being awake, so those are the questions. The workflow
 * list carries what is supposed to happen, and contributes the two facts no
 * execution can: a workflow that is switched on and has never fired, and one
 * whose draft has drifted ahead of the version its schedule actually runs.
 *
 * Archived workflows are dropped outright. Six of the eleven on this box are
 * archived TickTick experiments; they cannot run, and listing them would bury
 * the two that can under things that are finished.
 */
export async function loadN8n(base: string): Promise<N8nData> {
  const auth = { headers: { 'X-N8N-API-KEY': key('N8N_API_KEY') } }
  // Pinned in the flake and passed in as an env var. n8n's public API has no
  // version endpoint and /rest/settings does not carry one either, so the tag
  // the image is pinned to IS the running version — same reasoning as the
  // Factorio server's. Empty rather than absent when the nix side could not
  // parse a tag out of the pin, which is a real answer ("unknown") and not the
  // same as zero — hence `||`, which `??` would let through.
  const version = process.env.N8N_VERSION || null

  const [execs, flows] = await Promise.all([
    listExecutions(base, auth),
    getJson<{
      data?: {
        id: string
        name: string
        active?: boolean
        isArchived?: boolean
        versionId?: string | null
        activeVersionId?: string | null
      }[]
    }>(`${base}/api/v1/workflows?limit=250`, auth),
  ])

  const all = flows?.data ?? []
  const live = all.filter((f) => f.isArchived !== true)
  const known = new Map(live.map((f) => [f.id, f]))
  const now = Date.now()
  const floor = now - DAYS * 86400_000

  // Clamped to the window the chart draws, so the measure line beside it
  // counts the same runs. n8n prunes its own history well inside a fortnight,
  // so in practice this drops nothing.
  const rows = execs.rows
    .map((e) => ({ ...e, at: Date.parse(e.startedAt) }))
    .filter((e) => Number.isFinite(e.at) && e.at >= floor)
    .sort((a, b) => b.at - a.at)

  const dates = Array.from({ length: DAYS }, (_, i) => localDay(now - (DAYS - 1 - i) * 86400_000))
  const byDate = new Map(dates.map((d) => [d, { date: d, runs: 0, failed: 0 }]))
  for (const e of rows) {
    const day = byDate.get(localDay(e.at))
    if (day === undefined) continue
    day.runs++
    if (FAILED.has(e.status)) day.failed++
  }

  const perFlow = new Map<string, typeof rows>()
  // Seeded with every ACTIVE workflow, so one that is switched on and has
  // never fired gets a row saying so instead of being absent — which is the
  // state it would otherwise share with a workflow that does not exist. Not
  // the inactive ones: a parked draft with no runs is a row that says "off,
  // nothing", which is true of every draft anybody ever abandoned.
  for (const f of live) if (f.active === true) perFlow.set(f.id, [])
  // Archiving a workflow keeps its executions, so the runs it made before
  // being shelved would otherwise put it back on the page.
  const archivedIds = new Set(all.filter((f) => f.isArchived === true).map((f) => f.id))
  for (const e of rows) {
    if (archivedIds.has(e.workflowId)) continue
    perFlow.set(e.workflowId, [...(perFlow.get(e.workflowId) ?? []), e])
  }

  const flowRows: N8nFlow[] = [...perFlow].map(([id, mine]) => {
    const meta = known.get(id)
    const last = mine[0]?.at ?? now
    const durations = mine
      .filter((e) => typeof e.stoppedAt === 'string' && e.stoppedAt !== '')
      .map((e) => Date.parse(e.stoppedAt ?? '') - e.at)
      .filter((d) => Number.isFinite(d) && d >= 0)
    // Gaps between consecutive starts, newest-first list walked backwards.
    const gaps = mine.slice(1).map((e, i) => (mine[i]?.at ?? 0) - e.at)
    const every = mine.length >= 4 ? median(gaps) : null

    return {
      id,
      name: meta?.name ?? null,
      active: meta === undefined ? null : meta.active === true,
      runs: mine.length,
      failed: mine.filter((e) => FAILED.has(e.status)).length,
      medianMs: median(durations),
      everyMs: every,
      // An empty bucket has no last run, and `now` would render "just now" —
      // the opposite of the truth. The view keys off `runs === 0` instead.
      ago: mine.length === 0 ? DASH : since((now - last) / 1000),
      // Only meaningful for a workflow that HAS a published version: a draft
      // nobody ever published has `activeVersionId: null`, which is "off", not
      // "drifted".
      unpublished:
        meta?.activeVersionId != null &&
        meta.versionId != null &&
        meta.versionId !== meta.activeVersionId,
      // Two and a half cycles of silence, not one: a daily job that slips a few
      // hours is normal, and a claim that fires on a normal day is a claim
      // nobody reads twice. A workflow known to be switched off is not stalled,
      // it is off.
      stalled: every !== null && every > 0 && now - last > every * 2.5 && meta?.active !== false,
    }
  })

  return {
    version,
    gap: await versionGap('n8n-io/n8n', version, {
      // `n8n@2.33.4`, not `v2.33.4`. The repo also publishes moving `stable`
      // and `beta` tags, which this pattern drops by failing to match.
      tag: /^n8n@(\d+\.\d+\.\d+)$/,
      // A 1.x LTS line is published alongside 2.x and interleaved by date.
      // Without this the box is told it is dozens of releases behind, counting
      // patches to a line it is not on.
      sameMajor: true,
    }),
    daily: dates.map((d) => byDate.get(d) ?? { date: d, runs: 0, failed: 0 }),
    window: {
      days: DAYS,
      runs: rows.length,
      failed: rows.filter((e) => FAILED.has(e.status)).length,
      running: rows.filter((e) => RUNNING.has(e.status)).length,
      medianMs: median(
        rows
          .filter((e) => typeof e.stoppedAt === 'string' && e.stoppedAt !== '')
          .map((e) => Date.parse(e.stoppedAt ?? '') - e.at)
          .filter((d) => Number.isFinite(d) && d >= 0),
      ),
    },
    // By runs, because the bar beside each row is a ranking and a ranking that
    // is not sorted by its own bar is unreadable. A switched-on workflow that
    // has never fired therefore lands at the bottom, which is why it carries a
    // badge rather than relying on its position to be noticed.
    flows: flowRows.sort(
      (a, b) => b.runs - a.runs || (a.name ?? a.id).localeCompare(b.name ?? b.id),
    ),
    failures: rows
      .filter((e) => FAILED.has(e.status))
      .slice(0, 6)
      .map((e) => ({
        name: known.get(e.workflowId)?.name ?? e.workflowId.slice(0, 8),
        ago: since((now - e.at) / 1000),
      })),
    partial: execs.partial,
    archived: all.length - live.length,
    note: execs.refused
      ? 'n8n refused the executions API. The key needs the execution:read scope. Make one ' +
        'in Settings → n8n API and put it in stacks/daedalus/service-keys.sops as N8N_API_KEY.'
      : null,
    // A different, smaller problem than the one above, and worth saying
    // separately: the runs still count, the rows are just labelled with ids
    // and lose their on/off state.
    nameNote:
      !execs.refused && flows === null
        ? 'The API key cannot read workflows, so these are ids and their on/off state is unknown. ' +
          'Re-issue it in Settings → n8n API with the workflow:read scope.'
        : null,
  }
}
