import { defineBridge } from './bridge'
import { arrayOf, bool, type Decoder, nullable, num, obj, optional, str } from './contract/decode'
import { readSnapshot, type SnapshotResult } from './contract/snapshot'

// Project workspaces: the working clones under ~/projects on the host, where
// a Claude Code session works on a project directly from this box.
//
// Two channels, the standard pair. Facts arrive via the /workspaces snapshot
// (published by daedalus-workspace-{publish,sync} — live git state per clone
// plus its last sync outcome). The one action — "make this repo's workspace
// exist and make it current" — goes out through the file-drop bridge as a
// repo slug; the host clones over the operator's SSH identity, which is a
// push-capable credential this container must never hold.
//
// Keeping current is the host's job, not a button: hosted apps' workspaces
// pull right after each deploy lands (a path unit on the deploy state files),
// everything else every 30 minutes. The button exists for the first clone,
// and doubles as "pull now" because the host treats a clone of an existing
// workspace as exactly that.

export type WorkspaceSync = {
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
  // Optional-with-null rather than nullable alone: a clone that predates its
  // first sync has no state file, and the host publishes `null` for it.
  sync: optional(nullable(obj({ result: str, detail: str, at: str })), null),
})

const decoder: Decoder<WorkspacesData> = obj({
  root: str,
  workspaces: arrayOf(workspaceDecoder),
})

const EMPTY: WorkspacesData = { root: '', workspaces: [] }

export async function readWorkspaces(): Promise<SnapshotResult<WorkspacesData>> {
  return readSnapshot({
    path: process.env.WORKSPACES_PATH ?? '/workspaces/workspaces.json',
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

export type WorkspaceRequestState = 'idle' | 'running' | 'done' | 'failed'

export type WorkspaceRequestStatus = {
  id: string | null
  repo: string | null
  state: WorkspaceRequestState
  /** What happened, in the host's words — shown verbatim on success. */
  detail: string
  error: string
  startedAt: string | null
  finishedAt: string | null
}

const bridge = defineBridge<WorkspaceRequestStatus>({
  requestFile: 'workspace-request.json',
  statusFile: 'workspace-status.json',
  idle: {
    id: null,
    repo: null,
    state: 'idle',
    detail: '',
    error: '',
    startedAt: null,
    finishedAt: null,
  },
})

export async function readWorkspaceRequestStatus(): Promise<WorkspaceRequestStatus> {
  return bridge.readStatus()
}

export async function requestWorkspaceClone(input: {
  repo: string
  actor: string
}): Promise<string> {
  return bridge.request({ repo: input.repo, actor: input.actor })
}
