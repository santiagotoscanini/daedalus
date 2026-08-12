import { join } from 'node:path'
import {
  arrayOf,
  bool,
  type Decoder,
  literal,
  nullable,
  num,
  obj,
  optional,
  str,
} from './contract/decode'
import { readSnapshot } from './contract/snapshot'

// GitHub Actions state for an app, as published by gha-ci-snapshot
// (stacks/gha-runner/assets/ci-snapshot.sh) every 30 seconds.
//
// Read from a file rather than called from here: the PAT that answers these
// endpoints carries Administration:write on the repos, and the whole point of
// the runner design is that it never reaches a container. daedalus renders CI
// state; it does not get to register runners.
//
// One runner per app, ephemeral — it takes exactly one job, de-registers, and
// a fresh container replaces it. So a runner name changes on every job, and
// "offline" during the seconds between two jobs is normal rather than a fault.

const CI_DIR = process.env.CI_SNAPSHOT_DIR ?? '/ci'

export type Runner = {
  name: string
  status: 'online' | 'offline'
  busy: boolean
  labels: string[]
}

export type JobStep = {
  name: string
  status: 'queued' | 'in_progress' | 'completed'
  conclusion: string | null
  number: number
}

export type ActiveJob = {
  name: string
  status: 'queued' | 'in_progress'
  runnerName: string | null
  startedAt: string | null
  htmlUrl: string | null
  steps: JobStep[]
}

export type WorkflowRun = {
  id: number
  name: string | null
  status: string
  conclusion: string | null
  event: string
  sha: string
  title: string
  branch: string | null
  createdAt: string
  updatedAt: string
  htmlUrl: string
}

export type CiSnapshot = {
  /** False when the GitHub API could not be reached — NOT the same as "no runners". */
  ok: boolean
  available: boolean
  takenAt: string | null
  runners: Runner[]
  activeJobs: ActiveJob[]
  runs: WorkflowRun[]
}

// The decoders mirror the shapes ci-snapshot.sh emits. Every array is
// `optional(…, [])`: a truncated or short-fielded file used to cast straight
// to CiSnapshot, and the first `.runners.length` inside a streamed <Await>
// took the whole deployments tab down.
const runner: Decoder<Runner> = obj({
  name: str,
  status: literal('online', 'offline'),
  busy: bool,
  labels: optional(arrayOf(str), []),
})

const step: Decoder<JobStep> = obj({
  name: str,
  status: literal('queued', 'in_progress', 'completed'),
  conclusion: optional(nullable(str), null),
  number: num,
})

const activeJob: Decoder<ActiveJob> = obj({
  name: str,
  status: literal('queued', 'in_progress'),
  runnerName: optional(nullable(str), null),
  startedAt: optional(nullable(str), null),
  htmlUrl: optional(nullable(str), null),
  steps: optional(arrayOf(step), []),
})

const run: Decoder<WorkflowRun> = obj({
  id: num,
  name: optional(nullable(str), null),
  status: str,
  conclusion: optional(nullable(str), null),
  event: str,
  sha: str,
  title: optional(str, ''),
  branch: optional(nullable(str), null),
  createdAt: str,
  updatedAt: str,
  htmlUrl: str,
})

const snapshot = obj({
  ok: optional(bool, false),
  runners: optional(arrayOf(runner), []),
  activeJobs: optional(arrayOf(activeJob), []),
  runs: optional(arrayOf(run), []),
})

const NONE = { ok: false, runners: [], activeJobs: [], runs: [] }

export async function readCiSnapshot(app: string): Promise<CiSnapshot> {
  // Refreshed every 30s (OnUnitActiveSec in stacks/gha-runner); 5 minutes of
  // silence means the snapshot timer has stopped, and stale CI state should
  // read as unavailable rather than as the repo being quiet.
  const result = await readSnapshot({
    path: join(CI_DIR, `${app}.json`),
    decoder: snapshot,
    fallback: NONE,
    maxAgeMs: 5 * 60_000,
  })
  // No file: the app builds from local source, or the snapshot has not run
  // since boot. Reported as unavailable rather than as "no runners", which
  // would read as a fact about the repo.
  return {
    ...result.data,
    available: result.available && !result.stale,
    takenAt: result.generatedAt,
  }
}

// rollUp / shortenDigests moved to ci-lines.ts: the deployments tab renders
// with them in the BROWSER, and this module's node imports (readSnapshot →
// node:fs) must never ride the client bundle.
