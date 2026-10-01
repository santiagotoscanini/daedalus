import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ctx } from '../core/ctx'
import { type Decoder, nullable, num, obj, str } from '../lib/contract/decode'
import { readSnapshot } from './contract/snapshot'
import { env } from './env'
import { type RootAnswer, runRoot } from './root'

// Redeploy: pull the app's image and restart it if the digest moved.
//
// daedalus decides; the host executes. It cannot `podman pull` into the
// operator's rootless store or start a system unit, so it asks the root
// helper's `deploy` verb (through the controller, host/root.ts), which starts
// the app's EXISTING `app-<name>-deploy.service` — the one that already knows
// how to compare digests, health-check through traefik and mail on failure —
// and answers when it has finished.
//
// This is push on top of the poll, not instead of it. The deploy timer
// (nix/modules/apps/apps.nix, every 2 minutes by default) stays: a
// notification that arrives while the box is off is lost, whereas the timer's
// Persistent=true catches up on boot. Push removes latency, the timer keeps
// the system self-healing. A deploy the timer is already running is refused.

const DEPLOY_STATE = env.get('DEPLOY_STATE_DIR')

/** The helper waits 600 s for the unit (daedalus-verbs.nix `rootVerbs.deploy`); this is that and slack. */
export const DEPLOY_WAIT_MS = 620_000

/**
 * The last deploy as the app's own deploy unit published it —
 * `/deploy-state/<app>.json`, enveloped, written by publish_state in
 * nix/modules/apps/assets/deploy.sh.
 *
 * Timing fields are null wherever deploy.sh had none to record (a tick where
 * nothing new was pulled, a failure before the restart finished); `httpCode`
 * is the probe's answer, `"unverified"` for stage=off deploys where there is
 * no ingress to ask.
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
 * This is the authoritative record — a deploy also
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

/**
 * Run the app's deploy unit now, and the helper's word on how it went. The
 * name must be one of the verb's values (the box's deployable apps); anything
 * else is refused before a unit is named.
 */
export async function requestDeploy(
  ctx: Pick<Ctx, 'controller'>,
  input: { app: string; reason: string; actor: string },
): Promise<RootAnswer> {
  console.info(`[deploy] ${input.app}: ${input.reason}, asked by ${input.actor}`)
  return runRoot(ctx, 'deploy', { app: input.app }, DEPLOY_WAIT_MS)
}
