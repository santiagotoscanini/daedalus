import { type Decoder, literal, nullable, obj, optional, str } from '../lib/contract/decode'
import { REBOOT_REQUIRED } from '../lib/reboot-required'
import { defineBridge } from './bridge'

// The app half of Apply. It writes one file and reads another.
//
// Everything privileged happens on the host: a systemd.path unit watches
// apply-request.json and starts daedalus-apply.service, which writes the payload
// under site/, stages (and on the operator's switch, commits) it and runs
// nixos-rebuild (nix/stacks/daedalus/host/apply.sh). This container
// cannot rebuild anything and holds no credential that would let it — see
// host/bridge.ts for the mechanics and the trust boundary.

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

const bridge = defineBridge<ApplyStatus>({
  requestFile: 'apply-request.json',
  statusFile: 'apply-status.json',
  status: APPLY_STATUS,
})

/**
 * How long a `running` status may go unrefreshed before it is a corpse.
 *
 * apply.sh rewrites the whole status file — `finishedAt` included — at every
 * phase, so that field is "last written". Past the unit's TimeoutStartSec of
 * 30 minutes (nix/stacks/daedalus/daedalus-verbs.nix) systemd has killed the
 * run; five minutes of slack keeps a slow switch from being called dead while
 * it still goes. The two move together.
 */
const RUNNING_MAX_MS = 35 * 60_000

/**
 * The status, with a dead run reported as dead.
 *
 * The apply unit has no reaper, so a run killed at its timeout — or a box
 * that went down mid-Apply — leaves the file `running`, and the gate refuses
 * every Apply while it says so. This clock is what brings the button back.
 */
export async function readApplyStatus(): Promise<ApplyStatus> {
  const s = await bridge.readStatus()
  if (s.state === 'done' && s.phase === REBOOT_REQUIRED) {
    return { ...s, rebootPending: await notBootedSince(s.finishedAt) }
  }
  if (s.state !== 'running') return s

  const last = Date.parse(s.finishedAt ?? '')
  if (Number.isFinite(last) && Date.now() - last < RUNNING_MAX_MS) return s

  return {
    ...s,
    state: 'failed',
    error:
      `The host agent stopped writing during "${s.phase}" and did not report a result. ` +
      'The rebuild may or may not have completed — check `journalctl -u daedalus-apply` ' +
      'and `git log` in the configuration checkout before applying again.',
  }
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

/** Publish an apply request. apply-request.json carries metadata only; the files ride the id-stamped payload. */
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
    // The host prefixes the subject with what it wrote (`site:`, `nodes:`,
    // `apps:`), so a site- or nodes-only change names its fields and nothing else.
    if (only.name === 'site') return only.fields.join(', ')
    if (only.name === 'nodes') return only.fields.join(', ')
    return `${only.name}: ${only.fields.join(', ')}`
  }
  return `${String(changed.length)} apps updated (${changed.map((c) => c.name).join(', ')})`
}
