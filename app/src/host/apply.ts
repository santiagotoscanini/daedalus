import type { Ctx } from '../core/ctx'
import { type Decoder, literal, nullable, obj, optional, str } from '../lib/contract/decode'
import { REBOOT_REQUIRED } from '../lib/reboot-required'
import { defineRootVerb } from './root-verb'

// The app half of Apply: the root helper's `apply` verb (host/root-verb.ts
// has the mechanics).
//
// Everything privileged happens on the host: `daedalus-apply@<run>` writes
// the payload's files under site/, stages (and on the operator's switch,
// commits) them and runs nixos-rebuild (nix/stacks/daedalus/host/apply.sh).
// This container cannot rebuild anything and holds no credential that would
// let it; the names the host will write are its own list, never the payload's.

export type ApplyState = 'idle' | 'running' | 'done' | 'failed'

export type ApplyStatus = {
  id: string | null
  state: ApplyState
  phase: string
  error: string
  /** When the host agent took the request — null while idle. */
  startedAt: string | null
  finishedAt: string | null
  commit: string | null
  /** A `reboot-required` Apply the box has not booted since (readApplyStatus). Never in the file. */
  rebootPending?: boolean
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

const verb = defineRootVerb<ApplyStatus>({
  verb: 'apply',
  status: APPLY_STATUS,
  ended: (s) =>
    `The host agent ended during "${s.phase}" without reporting a result. ` +
    "The rebuild may or may not have completed — check `journalctl -u 'daedalus-apply@*'` " +
    'and `git log` in the configuration checkout before applying again.',
})

/**
 * The status, with a run that ended without its last word reported as dead
 * (host/root-verb.ts): a box that went down mid-Apply runs no reaper and
 * leaves the file `running`, and the gate refuses every Apply while it says
 * so. A `reboot-required` Apply says whether the box has booted since.
 */
export async function readApplyStatus(ctx: Pick<Ctx, 'controller'>): Promise<ApplyStatus> {
  const s = await verb.readStatus(ctx)
  if (s.state === 'done' && s.phase === REBOOT_REQUIRED) {
    return { ...s, rebootPending: await notBootedSince(s.finishedAt) }
  }
  return s
}

/**
 * Whether the box has not booted since `iso`: what keeps a `reboot-required`
 * Apply on the bar until the reboot it asked for. The container shares the
 * host's kernel, so /proc/uptime is the box's. Unreadable reads as pending —
 * a note too many beats a reboot nobody was told about.
 */
async function notBootedSince(iso: string | null): Promise<boolean> {
  const finished = Date.parse(iso ?? '')
  if (!Number.isFinite(finished)) return true
  try {
    const { readFile } = await import('node:fs/promises')
    const up = Number.parseFloat((await readFile('/proc/uptime', 'utf8')).split(' ')[0] ?? '')
    return !Number.isFinite(up) || Date.now() - up * 1000 < finished
  } catch {
    return true
  }
}

/**
 * The payload of an apply request: the exact bytes to land under site/,
 * rendered in this container (lib/registry-file.ts, core/site/file.ts) so the
 * host agent never manipulates JSON — it writes each file verbatim. Keyed by
 * file name, but the names the host will write are fixed in the agent
 * (apply.sh's MANAGED), never taken from the map.
 */
export type ApplyFiles = {
  'apps.json'?: string
  /** The machines that joined, as nix reads them (lib/nodes-file.ts). Rides every Apply like apps.json. */
  'nodes.json'?: string
  'site.json'?: string
  /** The directory's README, rendered from the document (core/site/file.ts). Rides every Apply. */
  'README.md'?: string
  /** The provenance stamp (core/site/file.ts): who wrote this directory, with
      which engine, when. Rides every Apply, and never decides its subject. */
  'daedalus.json'?: string
} & Partial<
  /** Ciphertext only — sealed in this container (core/vault.ts). */
  Record<import('../lib/vault').VaultFile, string>
>

/** Start an Apply: the files and what to record, as one payload; its id, or why it did not start. */
export function startApply(
  ctx: Pick<Ctx, 'controller'>,
  input: {
    files: ApplyFiles
    summary: string
    actor: string
    /** The operator's switch: commit what was written under site/ (staging is not optional). */
    commit: boolean
  },
) {
  return verb.start(
    ctx,
    JSON.stringify({
      actor: input.actor,
      summary: input.summary,
      commit: input.commit,
      files: input.files,
    }),
  )
}

/** Human-readable one-liner for the commit message. */
export function summarise(changed: { name: string; fields: string[] }[]): string {
  if (changed.length === 0) return 'no-op re-export'
  if (changed.length === 1) {
    const only = changed[0]
    if (!only) return 'update app registry'
    // The host prefixes the subject with what it wrote (`site:`, `nodes:`,
    // `apps:`), so a site- or nodes-only change names its fields and nothing else.
    if (only.name === 'site') return only.fields.join(', ')
    if (only.name === 'nodes') return only.fields.join(', ')
    return `${only.name}: ${only.fields.join(', ')}`
  }
  return `${String(changed.length)} apps updated (${changed.map((c) => c.name).join(', ')})`
}
