import type { SecretKeyHistory } from '../../../lib/apps/secret-keys'
import {
  bool,
  literal,
  nullable,
  num,
  obj,
  optional,
  recordOf,
  str,
} from '../../../lib/contract/decode'
import { env } from '../../env'
import { readSnapshot, type SnapshotResult } from '../snapshot'

// /repo/repo.json — the configuration repository as the host sees it, and
// the state of the site directory inside it, published by
// daedalus-repo-snapshot (nix/stacks/daedalus/host/repo-snapshot.sh in the
// engine). The container never mounts the repository; this is the
// whole of what it may know about it.

type RepoCommit = { rev: string; subject: string; committedAt: string }

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
/**
 * When each app secret was last written, and by whom: `<app> → <KEY> →
 * facts`.
 *
 * Derived from the git history of `site/vault/apps/<app>-env.sops` — the
 * newest commit whose diff added that key's line. Git IS the audit trail
 * here, and this is the only form of it the container can be shown: the
 * values are unreadable to it by design, so "who set this, and when" is
 * exactly as much as there is to say.
 */
type AppSecretHistory = Record<string, Record<string, SecretKeyHistory>>

export type SiteDir = {
  path: string
  exists: boolean
  /** The work tree the directory sits in; null = a plain directory. */
  toplevel: string | null
  /** That work tree is the configuration repository — the intended arrangement. */
  inThisRepo: boolean
  /** Every file daedalus writes there. */
  files: {
    'site.json': SiteFile
    'apps.json': SiteFile
    /** The machines (lib/nodes-file.ts). */
    'nodes.json': SiteFile
    'README.md': SiteFile
    'daedalus.json': SiteFile
  }
  /** Per-key git facts; see `AppSecretHistory`. */
  appSecrets: AppSecretHistory
}

/**
 * The engine as the configuration's `flake.lock` pins it — the `daedalus`
 * input's locked node. Null on a lock without that input and on a lock the
 * host could not read, and the Updates page says "unknown" for both rather
 * than guessing.
 *
 * `type` and `url` are the input as the host WROTE it: `git` with a
 * `file://` url is a local clone (the reference arrangement, where "latest"
 * is that clone's `main`), `github` is a published rev. The update agent
 * (nix/stacks/daedalus/host/engine-update.sh) branches on the same fields.
 */
export type EngineLock = {
  rev: string
  /** The locked commit's date, ISO 8601. */
  lastModified: string | null
  type: string
  url: string | null
  ref: string | null
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
  /** The pinned engine; see `EngineLock`. */
  engine: EngineLock | null
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

const NO_SITE_DIR: SiteDir = {
  path: '',
  exists: false,
  toplevel: null,
  inThisRepo: false,
  files: {
    'site.json': NO_FILE,
    'apps.json': NO_FILE,
    'nodes.json': NO_FILE,
    'README.md': NO_FILE,
    'daedalus.json': NO_FILE,
  },
  appSecrets: {},
}

const siteShape = obj({
  path: optional(str, ''),
  exists: optional(bool, false),
  toplevel: optional(nullable(str), null),
  inThisRepo: optional(bool, false),
  files: optional(
    obj({
      'site.json': optional(siteFile, NO_FILE),
      'apps.json': optional(siteFile, NO_FILE),
      'README.md': optional(siteFile, NO_FILE),
      'daedalus.json': optional(siteFile, NO_FILE),
      'nodes.json': optional(siteFile, NO_FILE),
    }),
    NO_SITE_DIR.files,
  ),
  // The key names are already visible to the container (it reads the
  // ciphertext), so what this adds is only WHEN and BY WHOM.
  // `recordOf(recordOf(...))` rather than a fixed key set — the apps and their
  // variables are both open sets.
  appSecrets: optional(
    recordOf(recordOf(obj({ setAt: str, actor: optional(str, ''), rev: optional(str, '') }))),
    {},
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
  site: optional(siteShape, NO_SITE_DIR),
  // `null` when the lock has no `daedalus` input.
  engine: optional(
    nullable(
      obj({
        rev: str,
        lastModified: optional(nullable(str), null),
        type: optional(str, ''),
        url: optional(nullable(str), null),
        ref: optional(nullable(str), null),
      }),
    ),
    null,
  ),
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
  engine: null,
}

/** The producing timer runs every 5 minutes; three misses is a stopped producer. */
const MAX_AGE_MS = 15 * 60_000

export async function repoFacts(): Promise<SnapshotResult<RepoFacts>> {
  return readSnapshot({
    path: env.get('REPO_FACTS_PATH'),
    decoder: shape,
    fallback: NO_REPO,
    acceptVersions: [7],
    maxAgeMs: MAX_AGE_MS,
  })
}
