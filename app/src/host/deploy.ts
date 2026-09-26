import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { type Decoder, literal, nullable, num, obj, optional, str } from '../lib/contract/decode'
import { defineBridge } from './bridge'
import { readSnapshot } from './contract/snapshot'
import { env } from './env'

// Redeploy: pull the app's image and restart it if the digest moved.
//
// daedalus decides; the host executes. It cannot `podman pull` into the operator's
// rootless store or restart a system unit, so it drops a request in the bind
// mount and daedalus-deploy-trigger.service starts the app's EXISTING
// `app-<name>-deploy.service` — the one that already knows how to compare
// digests, health-check through traefik and mail on failure.
//
// This is push on top of the poll, not instead of it. The deploy timer
// (nix/modules/apps/apps.nix, every 2 minutes by default) stays: a
// notification that arrives while the box is off is lost, whereas the timer's
// Persistent=true catches up on boot. Push removes latency, the timer keeps
// the system self-healing.

const DEPLOY_STATE = env.get('DEPLOY_STATE_DIR')

type DeployState = 'idle' | 'running' | 'done' | 'failed'

export type DeployStatus = {
  id: string | null
  app: string | null
  state: DeployState
  error: string
  /** When the host agent took the request — null until it has taken one. */
  startedAt: string | null
  finishedAt: string | null
}

/** The status file the host agent writes; decoding `{}` is the idle status. */
const DEPLOY_STATUS: Decoder<DeployStatus> = obj({
  id: optional(nullable(str), null),
  app: optional(nullable(str), null),
  state: optional(literal('idle', 'running', 'done', 'failed'), 'idle'),
  error: optional(str, ''),
  startedAt: optional(nullable(str), null),
  finishedAt: optional(nullable(str), null),
})

const bridge = defineBridge<DeployStatus>({
  requestFile: 'deploy-request.json',
  statusFile: 'deploy-status.json',
  status: DEPLOY_STATUS,
})

export async function readDeployStatus(): Promise<DeployStatus> {
  return bridge.readStatus()
}

/**
 * The last deploy as the app's own deploy unit published it —
 * `/deploy-state/<app>.json`, enveloped, written by publish_state in
 * nix/modules/apps/assets/deploy.sh.
 *
 * Timing fields are null wherever deploy.sh had none to record (a record it
 * synthesised from its older text state, a tick where nothing new was pulled,
 * a failure before the restart finished); `httpCode` is the probe's answer,
 * `"unverified"` for stage=off deploys where there is no ingress to ask.
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

/** True when pulls are currently failing (deploy.sh's `<app>.pull` marker beside the record). */
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
