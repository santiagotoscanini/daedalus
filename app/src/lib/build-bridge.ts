import { constants } from 'node:fs'
import { mkdir, open } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './bridge'
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
  redactBuildLog,
  tailFromBytes,
} from './builds'
import { readSnapshot, type SnapshotResult } from './contract/snapshot'

// The file half of the `build` verb (lib/builds.ts is the contract). Server-only.
//
//   /apply/build-request.json   written here; daedalus-build.path starts the host builder
//   /apply/build-status.json    written by host/build.sh, heartbeated while running
//   /builds/<id>.log            the host's already-redacted log, mounted read-only

const processEnv: EnvReader = (name) => {
  const v = process.env[name]
  return v === undefined || v === '' ? undefined : v
}

const applyDir = (env: EnvReader): string => env('APPLY_DIR') ?? '/apply'

/** Publish one build request. Throws DecodeError before writing anything invalid. */
export async function requestBuild(req: BuildRequest, env: EnvReader = processEnv): Promise<void> {
  const checked = buildRequestDecoder(req, '')
  const dir = applyDir(env)
  await mkdir(dir, { recursive: true })
  await writeAtomic(join(dir, BUILD_REQUEST_FILE), `${JSON.stringify(checked, null, 2)}\n`)
}

/**
 * The host's last status. `stale` past 90 s: a running build that stopped
 * heartbeating (lib/build-queue.ts `reconcile` turns that into `interrupted`).
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
      text: redactBuildLog(tailFromBytes(buffer.subarray(0, bytesRead), start > 0)),
      truncated: start > 0,
      sizeBytes: size,
    }
  } catch {
    return NO_LOG
  } finally {
    await handle.close()
  }
}
