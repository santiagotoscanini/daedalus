import { literal, nullable, num, obj, optional, str } from '../decode'
import { readSnapshot, type SnapshotResult } from '../snapshot'

// /repo/repo.json — the two repositories daedalus reasons about, as the host
// sees them, published by daedalus-repo-snapshot
// (stacks/daedalus/host/repo-snapshot.sh). The container never mounts either;
// this is the whole of what it may know about them.

export type RepoCommit = { rev: string; subject: string; committedAt: string }

/** The git facts both repositories are described by. */
export type GitFacts = {
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

/** A file the site repo holds, as a size and a hash — never as bytes. */
export type FileDigest = { sha256: string; bytes: number }

/**
 * `absent` — nothing at the path; the box has never been initialized.
 * `not-a-repo` — a directory is there but git is not, which is a state to
 * report rather than to overwrite.
 */
export type SiteRepoState = 'absent' | 'not-a-repo' | 'ready'

export type SiteRepo = GitFacts & {
  path: string
  state: SiteRepoState
  /** Digests of the managed files, for comparing against what daedalus renders. */
  files: { site: FileDigest | null; apps: FileDigest | null }
}

export type RepoFacts = GitFacts & {
  path: string
  site: SiteRepo
}

const commit = obj({ rev: str, subject: optional(str, ''), committedAt: optional(str, '') })

const gitShape = {
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
}

const NO_GIT: GitFacts = {
  remote: null,
  branch: null,
  head: null,
  tree: { modified: 0, untracked: 0 },
  upstream: null,
  lastApply: null,
}

const digest = obj({ sha256: str, bytes: optional(num, 0) })

export const NO_SITE_REPO: SiteRepo = {
  ...NO_GIT,
  path: '',
  state: 'absent',
  files: { site: null, apps: null },
}

const siteShape = obj({
  ...gitShape,
  path: optional(str, ''),
  state: optional(literal('absent', 'not-a-repo', 'ready'), 'absent'),
  files: optional(
    obj({ site: optional(nullable(digest), null), apps: optional(nullable(digest), null) }),
    { site: null, apps: null },
  ),
})

const shape = obj({
  ...gitShape,
  path: optional(str, ''),
  // Absent in a v1 snapshot — the shape published before the site repo
  // existed. A reader newer than its producer is the normal state for the
  // minutes between a switch and the timer's next run.
  site: optional(siteShape, NO_SITE_REPO),
})

export const NO_REPO: RepoFacts = {
  ...NO_GIT,
  path: '',
  site: NO_SITE_REPO,
}

/** The producing timer runs every 5 minutes; three misses is a stopped producer. */
const MAX_AGE_MS = 15 * 60_000

export async function repoFacts(): Promise<SnapshotResult<RepoFacts>> {
  return readSnapshot({
    path: process.env.REPO_FACTS_PATH ?? '/repo/repo.json',
    decoder: shape,
    fallback: NO_REPO,
    acceptVersions: [1, 2],
    maxAgeMs: MAX_AGE_MS,
  })
}
