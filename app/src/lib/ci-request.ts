import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

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
// Same shape as lib/apply.ts and lib/deploy.ts: write a temp file, rename it
// into place, let a systemd.path unit notice. Rename rather than write-in-place
// because the path unit fires on close-after-write too, and a half-serialised
// request must never be observable.

const APPLY_DIR = process.env.APPLY_DIR ?? '/apply'
const REQUEST = join(APPLY_DIR, 'ci-request.json')
const STATUS = join(APPLY_DIR, 'ci-status.json')

export type CiAction = 'set-secret' | 'run-ci'
export type CiRequestState = 'idle' | 'running' | 'done' | 'failed'

/**
 * The SSO half, on its own request file and its own host agent.
 *
 * Separate from the CI verbs above because the privileged thing it needs is
 * different in kind: those two hold a GitHub token, this one decrypts
 * clients.sops with the host key and commits to the flake. Keeping the agents
 * one-job-each is what lets each of them be read in a sitting.
 */
export type SsoAction = 'provision' | 'revoke'

export type SsoStatus = {
  id: string | null
  action: SsoAction | null
  app: string | null
  state: CiRequestState
  detail: string
  error: string
  finishedAt: string | null
}

const SSO_REQUEST = join(APPLY_DIR, 'sso-request.json')
const SSO_STATUS = join(APPLY_DIR, 'sso-status.json')

const SSO_IDLE: SsoStatus = {
  id: null,
  action: null,
  app: null,
  state: 'idle',
  detail: '',
  error: '',
  finishedAt: null,
}

export async function readSsoStatus(): Promise<SsoStatus> {
  try {
    return { ...SSO_IDLE, ...(JSON.parse(await readFile(SSO_STATUS, 'utf8')) as Partial<SsoStatus>) }
  } catch {
    return SSO_IDLE
  }
}

export async function requestSso(input: {
  action: SsoAction
  app: string
  actor: string
}): Promise<string> {
  const id = randomUUID()
  await mkdir(APPLY_DIR, { recursive: true })
  const tmp = `${SSO_REQUEST}.tmp`
  await writeFile(
    tmp,
    `${JSON.stringify(
      { id, action: input.action, app: input.app, actor: input.actor, requestedAt: new Date().toISOString() },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await rename(tmp, SSO_REQUEST)
  return id
}

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

const IDLE: CiRequestStatus = {
  id: null,
  action: null,
  repo: null,
  state: 'idle',
  detail: '',
  error: '',
  finishedAt: null,
}

export async function readCiRequestStatus(): Promise<CiRequestStatus> {
  try {
    return { ...IDLE, ...(JSON.parse(await readFile(STATUS, 'utf8')) as Partial<CiRequestStatus>) }
  } catch {
    // No status file: nothing has ever been requested from here.
    return IDLE
  }
}

export async function requestCi(input: {
  action: CiAction
  repo: string
  /** Publishing workflow filename. Required for run-ci, ignored otherwise. */
  workflow?: string
  actor: string
}): Promise<string> {
  const id = randomUUID()

  await mkdir(APPLY_DIR, { recursive: true })

  const tmp = `${REQUEST}.tmp`
  await writeFile(
    tmp,
    `${JSON.stringify(
      {
        id,
        action: input.action,
        repo: input.repo,
        workflow: input.workflow ?? '',
        actor: input.actor,
        requestedAt: new Date().toISOString(),
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  await rename(tmp, REQUEST)

  return id
}
