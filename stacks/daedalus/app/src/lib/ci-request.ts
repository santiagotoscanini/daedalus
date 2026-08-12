import { defineBridge } from './bridge'

// Asking the host to do the two repo-side things that cannot be done from here.
//
//   set-secret  puts the registry's `ci` password in the repo's Actions secrets.
//               The password is read by the host from /run/secrets and never
//               reaches this container — so this module sends a repo NAME, not
//               a value, and that asymmetry is deliberate.
//   run-ci      dispatches the publishing workflow, starting a one-shot runner
//               first if the repo has none. Without it the first image can
//               never be built: the workflow is `runs-on: self-hosted` and
//               pushes to zot over registry-net, so no hosted runner can do it,
//               and a repo only gets a runner once it is a declared app.
//
// Bridge mechanics (temp + rename, payload-before-trigger): lib/bridge.ts.

export type CiAction = 'set-secret' | 'run-ci'
export type CiRequestState = 'idle' | 'running' | 'done' | 'failed'

export type CiRequestStatus = {
  id: string | null
  action: CiAction | null
  repo: string | null
  state: CiRequestState
  /** What happened, in the host's words — shown verbatim on success. */
  detail: string
  error: string
  finishedAt: string | null
}

const bridge = defineBridge<CiRequestStatus>({
  requestFile: 'ci-request.json',
  statusFile: 'ci-status.json',
  idle: {
    id: null,
    action: null,
    repo: null,
    state: 'idle',
    detail: '',
    error: '',
    finishedAt: null,
  },
})

export async function readCiRequestStatus(): Promise<CiRequestStatus> {
  return bridge.readStatus()
}

export async function requestCi(input: {
  action: CiAction
  repo: string
  /** Publishing workflow filename. Required for run-ci, ignored otherwise. */
  workflow?: string
  actor: string
}): Promise<string> {
  return bridge.request({
    action: input.action,
    repo: input.repo,
    workflow: input.workflow ?? '',
    actor: input.actor,
  })
}
