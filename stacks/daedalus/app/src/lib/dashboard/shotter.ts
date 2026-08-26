// Shotter — the box's headless-browser lab (stacks/shotter), read for the
// Claude page. It is the eyes of the sessions that page shows: `shot` is how
// an agent here looks at a web page, and this module is how the operator
// looks at what the agent looked at.
//
// Three files, all under the read-only /shotter mount that the shotter stack
// itself binds into this container (the litellm idiom — the owner of the
// file contributes the mount):
//
//   stats.json      totals + the last run, rewritten after every run
//   history.jsonl   one line per run, append-only — the invocation ledger
//   runs/<id>/      the archive: viewport slices, events.json, log.txt
//
// No envelope and no staleness clock, unlike the snapshots this page's other
// facts ride in: these files are not republished by a timer — they change
// exactly when a run happens, so a quiet week is a true reading rather than
// a stopped producer.

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { bool, decode, nullable, num, obj, optional, str } from '../contract/decode'

export type ShotCounts = {
  consoleError: number
  consoleWarning: number
  pageError: number
  requestFailed: number
  http4xx: number
  http5xx: number
}

export type ShotRun = {
  id: string
  label: string
  /** The runner finished without throwing. Says nothing about the page — see counts. */
  ok: boolean
  at: number | null
  durationMs: number | null
  shots: number
  counts: ShotCounts
}

export type ShotterData = {
  /** The /shotter mount answered. False = the rebuild that binds it has not landed. */
  available: boolean
  totalRuns: number
  failedRuns: number
  /** When the ledger last moved. Quiet is a reading here, not a fault. */
  updatedAt: number | null
  /** Newest first, from the tail of the ledger. */
  runs: ShotRun[]
  /** Run directories actually on disk — prune keeps ~40; the ledger keeps all. */
  archived: number
  runsBytes: number | null
  /** The newest archived run: its slices for the thumbnails, its log excerpt. */
  latest: { id: string; shots: string[]; log: string[] } | null
}

const ZERO_COUNTS: ShotCounts = {
  consoleError: 0,
  consoleWarning: 0,
  pageError: 0,
  requestFailed: 0,
  http4xx: 0,
  http5xx: 0,
}

const countsShape = obj({
  consoleError: optional(num, 0),
  consoleWarning: optional(num, 0),
  pageError: optional(num, 0),
  requestFailed: optional(num, 0),
  http4xx: optional(num, 0),
  http5xx: optional(num, 0),
})

const runShape = obj({
  id: str,
  label: optional(str, ''),
  ok: optional(bool, false),
  startedAt: optional(nullable(str), null),
  durationMs: optional(nullable(num), null),
  shots: optional(num, 0),
  counts: optional(countsShape, ZERO_COUNTS),
})

const statsShape = obj({
  totalRuns: optional(num, 0),
  failedRuns: optional(num, 0),
  updatedAt: optional(nullable(str), null),
})

const RUNS_SHOWN = 20
const LOG_LINES = 30

const shotterDir = () => process.env.SHOTTER_DIR ?? '/shotter'

function isoMs(s: string | null): number | null {
  if (s === null) return null
  const t = Date.parse(s)
  return Number.isNaN(t) ? null : t
}

/** The ledger's tail, newest first. A malformed line is skipped, not fatal. */
async function ledger(root: string): Promise<ShotRun[]> {
  let raw: string
  try {
    raw = await readFile(join(root, 'history.jsonl'), 'utf8')
  } catch {
    return []
  }
  const runs: ShotRun[] = []
  for (const line of raw.split('\n').slice(-(RUNS_SHOWN + 1))) {
    if (line.trim() === '') continue
    try {
      const r = decode(runShape, JSON.parse(line))
      runs.push({
        id: r.id,
        label: r.label,
        ok: r.ok,
        at: isoMs(r.startedAt),
        durationMs: r.durationMs,
        shots: r.shots,
        counts: r.counts,
      })
    } catch {
      // A truncated tail line (the writer appends, this reader races it).
    }
  }
  return runs.slice(-RUNS_SHOWN).reverse()
}

async function dirBytes(dir: string): Promise<number | null> {
  try {
    let total = 0
    for (const e of await readdir(dir, { recursive: true, withFileTypes: true })) {
      if (!e.isFile()) continue
      total += (await stat(join(e.parentPath, e.name))).size
    }
    return total
  } catch {
    return null
  }
}

/** The newest run directory — run ids sort chronologically by construction. */
async function latestRun(runsDir: string): Promise<ShotterData['latest']> {
  let ids: string[]
  try {
    ids = (await readdir(runsDir, { withFileTypes: true }))
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort()
  } catch {
    return null
  }
  const id = ids.at(-1)
  if (id === undefined) return null
  const dir = join(runsDir, id)
  let shots: string[] = []
  try {
    shots = (await readdir(dir)).filter((f) => f.endsWith('.png')).sort()
  } catch {
    return null
  }
  let log: string[] = []
  try {
    log = (await readFile(join(dir, 'log.txt'), 'utf8'))
      .split('\n')
      .filter((l) => l.trim() !== '')
      .slice(-LOG_LINES)
  } catch {
    // A run can exist without a log (killed before the runner wrote one).
  }
  return { id, shots, log }
}

export async function loadShotter(): Promise<ShotterData> {
  const root = shotterDir()
  try {
    await readdir(root)
  } catch {
    return {
      available: false,
      totalRuns: 0,
      failedRuns: 0,
      updatedAt: null,
      runs: [],
      archived: 0,
      runsBytes: null,
      latest: null,
    }
  }

  const runsDir = join(root, 'runs')
  const stats = await readFile(join(root, 'stats.json'), 'utf8')
    .then((raw) => decode(statsShape, JSON.parse(raw)))
    .catch(() => ({ totalRuns: 0, failedRuns: 0, updatedAt: null }))
  const [runs, latest, runsBytes, archived] = await Promise.all([
    ledger(root),
    latestRun(runsDir),
    dirBytes(runsDir),
    readdir(runsDir)
      .then((es) => es.length)
      .catch(() => 0),
  ])

  return {
    available: true,
    totalRuns: stats.totalRuns,
    failedRuns: stats.failedRuns,
    updatedAt: isoMs(stats.updatedAt),
    runs,
    archived,
    runsBytes,
    latest,
  }
}

// ⚠ Same rule as every module here that touches node:fs — views import
// TYPES only, and reach the data through the Claude page's server function.
// See the foot of dashboard/claude.ts for the failure shape one value
// import produces.
