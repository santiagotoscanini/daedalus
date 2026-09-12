import { defineBridge } from './bridge'
import { type Decoder, literal, nullable, obj, optional, str } from './contract/decode'

// The app half of Apply. It writes one file and reads another.
//
// Everything privileged happens on the host: a systemd.path unit watches
// request.json and starts daedalus-apply.service, which commits the export
// and runs nixos-rebuild (stacks/daedalus/host/apply.sh). This container
// cannot rebuild anything and holds no credential that would let it — see
// lib/bridge.ts for the mechanics and the trust boundary.

export type ApplyState = 'idle' | 'running' | 'done' | 'failed'

export type ApplyStatus = {
  id: string | null
  state: ApplyState
  phase: string
  error: string
  /** When the host agent took the request — null on statuses from before v2. */
  startedAt: string | null
  finishedAt: string | null
  commit: string | null
}

/** The status file the host agent writes; decoding `{}` is the idle status. */
const APPLY_STATUS: Decoder<ApplyStatus> = obj({
  id: optional(nullable(str), null),
  state: optional(literal('idle', 'running', 'done', 'failed'), 'idle'),
  phase: optional(str, ''),
  error: optional(str, ''),
  startedAt: optional(nullable(str), null),
  finishedAt: optional(nullable(str), null),
  commit: optional(nullable(str), null),
})

const bridge = defineBridge<ApplyStatus>({
  requestFile: 'request.json',
  statusFile: 'status.json',
  status: APPLY_STATUS,
})

export async function readApplyStatus(): Promise<ApplyStatus> {
  return bridge.readStatus()
}

/**
 * Publish an apply request: the exact bytes to land under site/, rendered here
 * (lib/registry-file.ts, core/site/file.ts) so the host agent never
 * manipulates JSON — it writes each file of the id-stamped payload verbatim.
 * The payload is a map keyed by file name; the names the host will write are
 * fixed in the agent, never taken from the map. request.json carries metadata
 * only; the payload's name is derived from the id on both sides.
 */
export type ApplyFiles = {
  'apps.json'?: string
  'site.json'?: string
} & Partial<
  /** Ciphertext only — sealed in this container (core/vault.ts). */
  Record<import('./vault').VaultFile, string>
>

export async function requestApply(input: {
  files: ApplyFiles
  summary: string
  actor: string
  /** The operator's switch: commit what was written under site/ (staging is not optional). */
  commit: boolean
}): Promise<string> {
  return bridge.request(
    { actor: input.actor, summary: input.summary, commit: input.commit },
    `${JSON.stringify({ files: input.files }, null, 2)}\n`,
  )
}

/** Human-readable one-liner for the commit message. */
export function summarise(changed: { name: string; fields: string[] }[]): string {
  if (changed.length === 0) return 'no-op re-export'
  if (changed.length === 1) {
    const only = changed[0]
    if (!only) return 'update app registry'
    // The host prefixes the subject with what it wrote (`site:`, `apps:`), so a
    // site-only change names its fields and nothing else.
    if (only.name === 'site') return only.fields.join(', ')
    return `${only.name}: ${only.fields.join(', ')}`
  }
  return `${String(changed.length)} apps updated (${changed.map((c) => c.name).join(', ')})`
}
