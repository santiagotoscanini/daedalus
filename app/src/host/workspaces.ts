import type { Ctx } from '../core/ctx'
import {
  arrayOf,
  bool,
  type Decoder,
  nullable,
  num,
  obj,
  optional,
  str,
} from '../lib/contract/decode'
import { readSnapshot, type SnapshotResult } from './contract/snapshot'
import { env } from './env'
import { type RootAnswer, rootActor, runRoot } from './root'

// Project workspaces: the working clones under ~/projects on the host, where
// a Claude Code session works on a project directly from this box.
//
// Two channels, the standard pair. Facts arrive via the /workspaces snapshot
// (published by daedalus-workspace-{publish,sync}, nix/stacks/daedalus/
// daedalus-snapshots.nix — live git state per clone plus its last sync
// outcome). The one action — "make this repo's workspace
// exist and make it current" — goes to the root helper as a repo slug
// (`workspace-clone`); the host clones over the operator's SSH identity,
// which is a push-capable credential this container must never hold.
//
// Keeping current is the host's job, not a button: hosted apps' workspaces
// pull right after each deploy lands (a path unit on the deploy state files),
// everything else every 30 minutes. The button exists for the first clone,
// and doubles as "pull now" because the host treats a clone of an existing
// workspace as exactly that.

type WorkspaceSync = {
  /** ok | dirty (left alone) | blocked (not fast-forwardable) | failed. */
  result: string
  detail: string
  at: string
}

export type Workspace = {
  /** Directory name under the workspace root. */
  name: string
  /** owner/name GitHub slug, null when origin points somewhere else. */
  remote: string | null
  branch: string | null
  head: string | null
  headAt: string | null
  dirty: boolean
  /** Commits vs upstream; null when the branch tracks nothing. */
  ahead: number | null
  behind: number | null
  sync: WorkspaceSync | null
}

export type WorkspacesData = {
  root: string
  workspaces: Workspace[]
}

const workspaceDecoder: Decoder<Workspace> = obj({
  name: str,
  remote: nullable(str),
  branch: nullable(str),
  head: nullable(str),
  headAt: nullable(str),
  dirty: bool,
  ahead: nullable(num),
  behind: nullable(num),
  // `null` is what the host publishes for a clone with no sync state file
  // yet; `optional` also accepts an entry that omits the key.
  sync: optional(nullable(obj({ result: str, detail: str, at: str })), null),
})

const decoder: Decoder<WorkspacesData> = obj({
  root: str,
  workspaces: arrayOf(workspaceDecoder),
})

const EMPTY: WorkspacesData = { root: '', workspaces: [] }

export async function readWorkspaces(): Promise<SnapshotResult<WorkspacesData>> {
  return readSnapshot({
    path: env.get('WORKSPACES_PATH'),
    decoder,
    fallback: EMPTY,
    acceptVersions: [1],
    // 3× the sync timer's 30 minutes: one missed run is jitter, three is a
    // stopped producer.
    maxAgeMs: 90 * 60_000,
  })
}

/** The workspace holding a clone of `repo` (owner/name), if one exists. */
export function workspaceFor(repo: string, data: WorkspacesData): Workspace | null {
  const want = repo.toLowerCase()
  return data.workspaces.find((w) => w.remote?.toLowerCase() === want) ?? null
}

/**
 * The helper's word waits for the clone unit's own 15 minutes (a large repo
 * on a slow evening, plus the workspace lock) and the start job's minute:
 * the verb's timeoutSec (nix/stacks/daedalus/daedalus-verbs.nix), and a
 * little more.
 */
const CLONE_WAIT_MS = 980_000

/**
 * Clone `repo` (owner/name) into the workspace root, or fast-forward the
 * clone that is already there: the root helper's `workspace-clone`, which
 * holds the slug to its pattern and hands it to the unit in a run file. The
 * answer is the unit's outcome: what it did, or why it refused.
 */
export async function requestWorkspaceClone(
  ctx: Pick<Ctx, 'controller'>,
  input: { repo: string; actor: string },
): Promise<RootAnswer> {
  return runRoot(
    ctx,
    'workspace-clone',
    { repo: input.repo, actor: rootActor(input.actor) },
    CLONE_WAIT_MS,
  )
}
