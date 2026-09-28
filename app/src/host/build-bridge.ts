import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import {
  BUILD_REQUEST_FILE,
  BUILD_STATUS_FILE,
  BUILD_STATUS_MAX_AGE_MS,
  type BuildRequest,
  type BuildStatus,
  buildLogPath,
  buildRequestDecoder,
  buildStatusDecoder,
  type EnvReader,
  NO_BUILD,
  serializeBuildRequest,
  tailFromBytes,
} from '../lib/builds'
import { redactSecrets } from '../lib/redact'
import { writeAtomic } from './bridge'
import { readSnapshot, type SnapshotResult } from './contract/snapshot'
import type { ControllerClient } from './controller/client'
import { env } from './env'
import { type RootAnswer, runRoot } from './root'

// The file half of the `build` verb (lib/builds.ts is the contract). Server-only.
//
//   /apply/build-request.json         written here; daedalus-build.path starts the host builder
//   root.run build-cancel {app}       asked here; daedalus-build-cancel@<app> stops it
//   /apply/build-status.json          written by nix/stacks/daedalus/host/build.sh, heartbeated while running
//   /builds/<id>.log                  the host's already-redacted log, mounted read-only

const processEnv: EnvReader = (name) => env.text(name)

const applyDir = (env: EnvReader): string => env('APPLY_DIR') ?? '/apply'

/** Publish one build request. Throws DecodeError before writing anything invalid. */
export async function requestBuild(req: BuildRequest, env: EnvReader = processEnv): Promise<void> {
  const checked = buildRequestDecoder(req, '')
  const dir = applyDir(env)
  await mkdir(dir, { recursive: true })
  // The same bytes core/builds/dispatch.ts measured against BUILD_REQUEST_MAX_BYTES.
  await writeAtomic(join(dir, BUILD_REQUEST_FILE), serializeBuildRequest(checked))
}

/** The helper waits 150 s for the stop (build-agent.nix `rootVerbs.build-cancel`); this is that and slack. */
const CANCEL_WAIT_MS = 170_000

/**
 * Ask the host to stop the build in flight, if it is this app's: the root
 * helper's `build-cancel` (host/root.ts) starts `daedalus-build-cancel@<app>`,
 * which refuses a build in flight that is another app's, or none — a cancel
 * that lost a race to a build finishing cannot kill another app's next one.
 * Answers once the unit has stopped (the build's reaper has run by then).
 */
export async function requestBuildCancel(
  app: string,
  client?: ControllerClient,
): Promise<RootAnswer> {
  return runRoot('build-cancel', { app }, CANCEL_WAIT_MS, client)
}

/**
 * The host's last status. `stale` past BUILD_STATUS_MAX_AGE_MS (90 s): a
 * running build that stopped heartbeating (lib/build-queue.ts `reconcile`
 * turns that into `interrupted`).
 */
export async function readBuildStatus(
  env: EnvReader = processEnv,
): Promise<SnapshotResult<BuildStatus | null>> {
  return readSnapshot<BuildStatus | null>({
    path: join(applyDir(env), BUILD_STATUS_FILE),
    decoder: buildStatusDecoder,
    fallback: NO_BUILD,
    maxAgeMs: BUILD_STATUS_MAX_AGE_MS,
  })
}

export const DEFAULT_LOG_TAIL_BYTES = 64_000
const MAX_LOG_TAIL_BYTES = 1024 * 1024

export type BuildLogTail = {
  available: boolean
  text: string
  /** The file is longer than what was read. */
  truncated: boolean
  sizeBytes: number | null
}

const NO_LOG: BuildLogTail = { available: false, text: '', truncated: false, sizeBytes: null }

/** The last `maxBytes` of a build's log, redacted. Unavailable for a malformed id. */
export async function readBuildLogTail(
  id: string,
  opts: { maxBytes?: number; env?: EnvReader } = {},
): Promise<BuildLogTail> {
  const path = buildLogPath(id, opts.env ?? processEnv)
  if (path === null) return NO_LOG
  const want = Math.max(1, Math.min(opts.maxBytes ?? DEFAULT_LOG_TAIL_BYTES, MAX_LOG_TAIL_BYTES))

  let handle: Awaited<ReturnType<typeof open>>
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  } catch {
    return NO_LOG
  }
  try {
    const { size } = await handle.stat()
    const length = Math.min(size, want)
    const start = size - length
    const buffer = Buffer.alloc(length)
    const { bytesRead } = await handle.read(buffer, 0, length, start)
    return {
      available: true,
      text: redactSecrets(tailFromBytes(buffer.subarray(0, bytesRead), start > 0)),
      truncated: start > 0,
      sizeBytes: size,
    }
  } catch {
    return NO_LOG
  } finally {
    await handle.close()
  }
}
