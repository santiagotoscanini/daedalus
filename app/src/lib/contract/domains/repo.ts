import { bool, literal, nullable, num, obj, optional, str } from '../decode'
import { readSnapshot, type SnapshotResult } from '../snapshot'

// /repo/repo.json — the configuration repository as the host sees it, and
// the state of the site directory inside it, published by
// daedalus-repo-snapshot (stacks/daedalus/host/repo-snapshot.sh in the
// s2-server repo). The container never mounts the repository; this is the
// whole of what it may know about it.

export type RepoCommit = { rev: string; subject: string; committedAt: string }

/**
 * What a REBUILD would see. A flake copies the working tree of tracked files,
 * so `clean`, `modified` and `staged` are all visible to nix; `untracked` is
 * not — the "file not found" trap — and is the one status that is a warning.
 * `unversioned` is a file in a directory git does not manage at all.
 */
export type SiteFileStatus =
  | 'absent'
  | 'untracked'
  | 'staged'
  | 'modified'
  | 'clean'
  | 'unversioned'

export type SiteFile = { status: SiteFileStatus; sha256: string | null }

export type SiteDir = {
  path: string
  exists: boolean
  /** The work tree the directory sits in; null = a plain directory. */
  toplevel: string | null
  /** That work tree is the configuration repository — the intended arrangement. */
  inThisRepo: boolean
  files: { 'site.json': SiteFile; 'apps.json': SiteFile }
}

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
  site: SiteDir
}

const commit = obj({ rev: str, subject: optional(str, ''), committedAt: optional(str, '') })

const NO_FILE: SiteFile = { status: 'absent', sha256: null }

const siteFile = obj({
  status: optional(
    literal('absent', 'untracked', 'staged', 'modified', 'clean', 'unversioned'),
    'absent',
  ),
  sha256: optional(nullable(str), null),
})

export const NO_SITE_DIR: SiteDir = {
  path: '',
  exists: false,
  toplevel: null,
  inThisRepo: false,
  files: { 'site.json': NO_FILE, 'apps.json': NO_FILE },
}

const siteShape = obj({
  path: optional(str, ''),
  exists: optional(bool, false),
  toplevel: optional(nullable(str), null),
  inThisRepo: optional(bool, false),
  files: optional(
    obj({ 'site.json': optional(siteFile, NO_FILE), 'apps.json': optional(siteFile, NO_FILE) }),
    NO_SITE_DIR.files,
  ),
})

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
  // Absent in the v1 and v2 shapes. A reader newer than its producer is the
  // normal state for the minutes between a switch and the timer's next run.
  site: optional(siteShape, NO_SITE_DIR),
})

export const NO_REPO: RepoFacts = {
  path: '',
  remote: null,
  branch: null,
  head: null,
  tree: { modified: 0, untracked: 0 },
  upstream: null,
  lastApply: null,
  site: NO_SITE_DIR,
}

/** The producing timer runs every 5 minutes; three misses is a stopped producer. */
const MAX_AGE_MS = 15 * 60_000

export async function repoFacts(): Promise<SnapshotResult<RepoFacts>> {
  return readSnapshot({
    path: process.env.REPO_FACTS_PATH ?? '/repo/repo.json',
    decoder: shape,
    fallback: NO_REPO,
    // v2 carried a `site` of a different shape (the retired separate-repo
    // design); decoding it lands on the fallbacks, which is the honest answer.
    acceptVersions: [1, 2, 3],
    maxAgeMs: MAX_AGE_MS,
  })
}
