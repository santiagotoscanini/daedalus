import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// The app half of Apply. It writes one file and reads another.
//
// Everything privileged happens on the host: a systemd.path unit watches
// request.json and starts daedalus-apply.service, which commits the export
// and runs nixos-rebuild (stacks/daedalus/host/apply.sh). This container
// cannot rebuild anything and holds no credential that would let it — the
// trust boundary is "can write into /apply", and the Pocket ID gate in front
// of the app is what guards that.

const APPLY_DIR = process.env.APPLY_DIR ?? '/apply'
const REQUEST = join(APPLY_DIR, 'request.json')
const PAYLOAD = join(APPLY_DIR, 'apps.json')
const STATUS = join(APPLY_DIR, 'status.json')

export type ApplyState = 'idle' | 'running' | 'done' | 'failed'

export type ApplyStatus = {
  id: string | null
  state: ApplyState
  phase: string
  error: string
  finishedAt: string | null
  commit: string | null
}

const IDLE: ApplyStatus = {
  id: null,
  state: 'idle',
  phase: '',
  error: '',
  finishedAt: null,
  commit: null,
}

export async function readApplyStatus(): Promise<ApplyStatus> {
  try {
    return { ...IDLE, ...(JSON.parse(await readFile(STATUS, 'utf8')) as Partial<ApplyStatus>) }
  } catch {
    // No status file yet — nothing has ever been applied from here.
    return IDLE
  }
}

/**
 * Publish an apply request. Returns the id, which the caller polls for.
 *
 * Two files, written in this order:
 *
 *   apps.json    — the exact bytes to land in the flake. Rendered here (see
 *                  lib/registry-file.ts) so the host agent never manipulates
 *                  JSON; it copies this file verbatim.
 *   request.json — metadata only: id, who, what changed. This is what the
 *                  path unit watches, so it is written LAST — the trigger
 *                  must not fire before the payload exists.
 *
 * Both go through a temp file and a rename. systemd's path unit fires on
 * rename-into-place, so a half-serialised request is never observable; writing
 * in place would let the agent start against a truncated file.
 */
export async function requestApply(input: {
  fileBody: string
  summary: string
  actor: string
}): Promise<string> {
  const id = randomUUID()

  await mkdir(dirname(REQUEST), { recursive: true })

  await writeAtomic(PAYLOAD, input.fileBody)
  await writeAtomic(
    REQUEST,
    `${JSON.stringify(
      {
        id,
        requestedAt: new Date().toISOString(),
        actor: input.actor,
        summary: input.summary,
      },
      null,
      2,
    )}\n`,
  )

  return id
}

async function writeAtomic(path: string, body: string): Promise<void> {
  const tmp = `${path}.tmp`
  await writeFile(tmp, body, 'utf8')
  await rename(tmp, path)
}

/** Human-readable one-liner for the commit message. */
export function summarise(changed: { name: string; fields: string[] }[]): string {
  if (changed.length === 0) return 'no-op re-export'
  if (changed.length === 1) {
    const only = changed[0]
    if (!only) return 'update app registry'
    return `${only.name}: ${only.fields.join(', ')}`
  }
  return `${String(changed.length)} apps updated (${changed.map((c) => c.name).join(', ')})`
}
