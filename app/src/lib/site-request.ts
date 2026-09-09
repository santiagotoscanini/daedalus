import { defineBridge } from './bridge'

// Asking the host to create, adopt and commit to the site repository.
//
// The repository lives on the host at `fleet.site.path` and this container
// never mounts it — the same boundary as the configuration repo. So the app
// does what it does for Apply: it renders the exact bytes and hands them over,
// and the host writes, commits and (if there is a remote) pushes them.
//
// One verb so far. `init` is idempotent by construction: it creates the repo
// if it is not there, writes the files it is given, and commits only what
// actually changed — so running it again on a configured box is a no-op that
// reports itself as one, and running it after a setting changed is how the
// mirror catches up.
//
// Bridge mechanics (temp + rename, payload-before-trigger): lib/bridge.ts.

export type SiteAction = 'init'
export type SiteRequestState = 'idle' | 'running' | 'done' | 'failed'

/** The names the host is allowed to write. Fixed HERE and checked again on
    the host: a filename that travelled in a payload is a path traversal. */
export const SITE_FILES = ['site.json', 'apps.json', 'README.md'] as const
export type SiteFileName = (typeof SITE_FILES)[number]

export type SiteRequestStatus = {
  id: string | null
  action: SiteAction | null
  state: SiteRequestState
  /** Drives the progress display: creating, writing, committing, pushing. */
  phase: string
  /** What happened, in the host's words — shown verbatim on success. */
  detail: string
  error: string
  startedAt: string | null
  finishedAt: string | null
  /** The commit this run created; empty when it changed nothing. */
  commit: string | null
}

const bridge = defineBridge<SiteRequestStatus>({
  requestFile: 'site-request.json',
  statusFile: 'site-status.json',
  idle: {
    id: null,
    action: null,
    state: 'idle',
    phase: '',
    detail: '',
    error: '',
    startedAt: null,
    finishedAt: null,
    commit: null,
  },
})

export async function readSiteRequestStatus(): Promise<SiteRequestStatus> {
  return bridge.readStatus()
}

export async function requestSiteInit(input: {
  /** `owner/name`, or empty for a repository with no remote at all. */
  remote: string
  /** Create `remote` on GitHub, private, before pushing to it. */
  createRemote: boolean
  summary: string
  actor: string
  files: Record<SiteFileName, string>
}): Promise<string> {
  return bridge.request(
    {
      action: 'init' satisfies SiteAction,
      remote: input.remote,
      createRemote: input.createRemote,
      summary: input.summary,
      actor: input.actor,
    },
    // The files ride as one payload document rather than one file each: the
    // bridge stamps a single payload with the request's id, which is what
    // makes a queued second request unable to touch the bytes this one is
    // committing.
    `${JSON.stringify({ files: input.files }, null, 2)}\n`,
  )
}
