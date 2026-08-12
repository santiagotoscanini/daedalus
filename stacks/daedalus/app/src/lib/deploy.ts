import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { defineBridge } from './bridge'
import { type Decoder, nullable, num, obj, str } from './contract/decode'
import { readSnapshot } from './contract/snapshot'

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
  /** When the host agent took the request — null on statuses from before v2. */
  startedAt: string | null
  finishedAt: string | null
}

const bridge = defineBridge<DeployStatus>({
  requestFile: 'deploy-request.json',
  statusFile: 'deploy-status.json',
  idle: { id: null, app: null, state: 'idle', error: '', startedAt: null, finishedAt: null },
})

export async function readDeployStatus(): Promise<DeployStatus> {
  return bridge.readStatus()
}

/**
 * The last deploy as the app's own deploy unit published it —
 * `/deploy-state/<app>.json`, enveloped, written by publish_state in
 * stacks/apps/assets/deploy.sh.
 *
 * Timing fields are null on records migrated from the pre-JSON text state
 * (the script synthesises those once, on its first tick after the format
 * change); `httpCode` is the probe's answer, `"unverified"` for stage=off
 * deploys where there is no ingress to ask.
 */
export type DeployRecord = {
  app: string
  digest: string
  result: string
  httpCode: string | null
  startedAt: string | null
  finishedAt: string | null
  durationMs: number | null
  previousDigest: string | null
}

const deployRecord: Decoder<DeployRecord> = obj({
  app: str,
  digest: str,
  result: str,
  httpCode: nullable(str),
  startedAt: nullable(str),
  finishedAt: nullable(str),
  durationMs: nullable(num),
  previousDigest: nullable(str),
})

/**
 * This is the authoritative record, not our request status — a deploy also
 * runs from the timer, and from a manual `systemctl start`, neither of which
 * goes through daedalus. No maxAgeMs: deploys happen when digests move, so an
 * old record is history, not staleness.
 */
export async function lastDeploy(app: string): Promise<DeployRecord | null> {
  const snap = await readSnapshot<DeployRecord | null>({
    path: join(DEPLOY_STATE, `${app}.json`),
    decoder: deployRecord,
    fallback: null,
    acceptVersions: [1],
  })
  return snap.available ? snap.data : null
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
