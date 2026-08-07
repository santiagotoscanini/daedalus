import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'

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

const NONE: CiSnapshot = {
  ok: false,
  available: false,
  takenAt: null,
  runners: [],
  activeJobs: [],
  runs: [],
}

export async function readCiSnapshot(app: string): Promise<CiSnapshot> {
  const path = join(CI_DIR, `${app}.json`)
  try {
    const [raw, takenAt] = await Promise.all([
      readFile(path, 'utf8'),
      stat(path).then((s) => s.mtime.toISOString()),
    ])
    const parsed = JSON.parse(raw) as Omit<CiSnapshot, 'available' | 'takenAt'>
    return { ...parsed, available: true, takenAt }
  } catch {
    // No file: the app builds from local source, or the snapshot has not run
    // since boot. Reported as unavailable rather than as "no runners", which
    // would read as a fact about the repo.
    return NONE
  }
}
