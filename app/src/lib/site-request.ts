import { defineBridge } from './bridge'

// Asking the host to write the site files into the site directory — the one
// directory daedalus owns inside the operator's configuration repository.
//
// This container never mounts that repository, so the app does what it does
// for Apply: it renders the exact bytes and hands them over, and the host
// writes them, stages them if the directory is under source control (a flake
// sees only tracked files — that part is not optional), and commits only if
// the request says so. Whether to commit is an operator preference the app
// passes along on every request; the agent keeps no state about it.
//
// One verb. `write` is idempotent by construction: it writes what it is given,
// stages, finds nothing changed and says so — so running it on a current
// directory is a no-op that reports itself as one.
//
// Bridge mechanics (temp + rename, payload-before-trigger): lib/bridge.ts.

export type SiteAction = 'write'
export type SiteRequestState = 'idle' | 'running' | 'done' | 'failed'

/** The names the host is allowed to write, fixed HERE and again in the
    agent: a filename that travelled in a payload is a path traversal.
    apps.json is deliberately absent — only an Apply writes it. */
export const SITE_FILES = ['site.json', 'README.md'] as const
export type SiteFileName = (typeof SITE_FILES)[number]

export type SiteRequestStatus = {
  id: string | null
  action: SiteAction | null
  state: SiteRequestState
  /** Drives the progress display: validating, writing, staging, committing. */
  phase: string
  /** What happened, in the host's words — shown verbatim on success. */
  detail: string
  error: string
  startedAt: string | null
  finishedAt: string | null
  /** The commit this run created; empty when it changed nothing or did not commit. */
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

export async function requestSiteWrite(input: {
  commit: boolean
  summary: string
  actor: string
  files: Record<SiteFileName, string>
}): Promise<string> {
  return bridge.request(
    {
      action: 'write' satisfies SiteAction,
      commit: input.commit,
      summary: input.summary,
      actor: input.actor,
    },
    // One payload document keyed by name: the bridge stamps it with the
    // request's id, which is what keeps a queued second request from touching
    // the bytes this one is writing.
    `${JSON.stringify({ files: input.files }, null, 2)}\n`,
  )
}
