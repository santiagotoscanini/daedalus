import { nullable, num, obj, optional, str } from '../decode'
import { readSnapshot, type SnapshotResult } from '../snapshot'

// /repo/repo.json — the configuration repository as the host sees it,
// published by daedalus-repo-snapshot (stacks/daedalus/host/repo-snapshot.sh).
// The container never mounts the repo itself; this is the whole of what it
// may know about it.

export type RepoCommit = { rev: string; subject: string; committedAt: string }

export type RepoFacts = {
  path: string
  remote: string | null
  branch: string | null
  head: RepoCommit | null
  /** Tracked changes vs untracked files — counted apart because a rebuild
      sees the former and not the latter. */
  tree: { modified: number; untracked: number }
  /** Against the last ref a push or pull left; the snapshot never fetches. */
  upstream: { ref: string; ahead: number; behind: number } | null
  /** The most recent commit the apply agent authored. */
  lastApply: RepoCommit | null
}

const commit = obj({ rev: str, subject: optional(str, ''), committedAt: optional(str, '') })

const shape = obj({
  path: optional(str, ''),
  remote: optional(nullable(str), null),
  branch: optional(nullable(str), null),
  head: optional(nullable(commit), null),
  tree: optional(obj({ modified: optional(num, 0), untracked: optional(num, 0) }), {
    modified: 0,
    untracked: 0,
  }),
  upstream: optional(
    nullable(obj({ ref: str, ahead: optional(num, 0), behind: optional(num, 0) })),
    null,
  ),
  lastApply: optional(nullable(commit), null),
})

export const NO_REPO: RepoFacts = {
  path: '',
  remote: null,
  branch: null,
  head: null,
  tree: { modified: 0, untracked: 0 },
  upstream: null,
  lastApply: null,
}

/** The producing timer runs every 5 minutes; three misses is a stopped producer. */
const MAX_AGE_MS = 15 * 60_000

export async function repoFacts(): Promise<SnapshotResult<RepoFacts>> {
  return readSnapshot({
    path: process.env.REPO_FACTS_PATH ?? '/repo/repo.json',
    decoder: shape,
    fallback: NO_REPO,
    acceptVersions: [1],
    maxAgeMs: MAX_AGE_MS,
  })
}
