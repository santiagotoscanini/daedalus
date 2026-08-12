import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineBridge } from './bridge'

// Redeploy: pull the app's image and restart it if the digest moved.
//
// daedalus decides; the host executes. It cannot `podman pull` into santiago's
// rootless store or restart a system unit, so it drops a request in the bind
// mount and daedalus-deploy-trigger.service starts the app's EXISTING
// `app-<name>-deploy.service` — the one that already knows how to compare
// digests, health-check through traefik and mail on failure.
//
// This is push on top of the poll, not instead of it. The 2-minute timer in
// stacks/apps stays: a notification that arrives while the box is off is lost,
// whereas the timer's Persistent=true catches up on boot. Push removes
// latency, the timer keeps the system self-healing.

const DEPLOY_STATE = process.env.DEPLOY_STATE_DIR ?? '/deploy-state'

export type DeployState = 'idle' | 'running' | 'done' | 'failed'

export type DeployStatus = {
  id: string | null
  app: string | null
  state: DeployState
  error: string
  finishedAt: string | null
}

const bridge = defineBridge<DeployStatus>({
  requestFile: 'deploy-request.json',
  statusFile: 'deploy-status.json',
  idle: { id: null, app: null, state: 'idle', error: '', finishedAt: null },
})

export async function readDeployStatus(): Promise<DeployStatus> {
  return bridge.readStatus()
}

/**
 * Last result recorded by the app's own deploy unit: `<digest> ok|failed`.
 *
 * This is the authoritative record, not our request status — a deploy also
 * runs from the timer, and from a manual `systemctl start`, neither of which
 * goes through daedalus.
 */
export async function lastDeploy(app: string): Promise<{ digest: string; result: string } | null> {
  try {
    const raw = (await readFile(join(DEPLOY_STATE, app), 'utf8')).trim()
    const [digest, result] = raw.split(/\s+/)
    if (!digest) return null
    return { digest, result: result ?? 'unknown' }
  } catch {
    return null
  }
}

/** True when pulls are currently failing (sibling marker file from deploy.sh). */
export async function pullFailing(app: string): Promise<boolean> {
  try {
    await readFile(join(DEPLOY_STATE, `${app}.pull`), 'utf8')
    return true
  } catch {
    return false
  }
}

export async function requestDeploy(input: {
  app: string
  reason: string
  actor: string
}): Promise<string> {
  return bridge.request({ app: input.app, reason: input.reason, actor: input.actor })
}
