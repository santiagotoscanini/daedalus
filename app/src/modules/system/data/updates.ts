import { type EngineLock, repoFacts } from '../../../host/contract/domains/repo'
import { type NixosFacts, siteIdentity } from '../../../host/contract/domains/site'
import { readCommittedSite } from '../../../host/contract/domains/site-doc'
import { type EngineUpdateStatus, readEngineUpdateStatus } from '../../../host/engine-update'
import { type ImageUpdateStatus, readImageUpdateStatus } from '../../../host/image-update'
import { readWorkspaces, type Workspace, workspaceFor } from '../../../host/workspaces'
import { type UpdateRow, updateRows } from '../../../lib/dashboard/update-rows'
import { ENGINE_REPO } from '../../../lib/engine'

export {
  loadUpdateNotes,
  type UpdateRow,
} from '../../../lib/dashboard/update-rows'

// Every digest-pinned container on the box, and whether it is behind.
//
// Dozens of containers — the exporters, the redis and postgres sidecars — have
// no tab and never will: nobody opens scraparr, and a Board about
// node-exporter would say nothing a person wants. What they DO have is a pin
// that ages exactly like Jellyfin's, and this is where that fact appears.
//
// ── it costs no network ───────────────────────────────────────────────────
//
// Everything here is a local read: the pins come from the nix export, the
// verdicts from the registry probe, the running versions from image labels —
// snapshot files, all already cached by their own modules. That is what makes
// a table of every container reasonable to render at all.
//
// The changelogs are NOT here, deliberately. A GitHub release list per
// container on every page load would spend the hourly budget in one visit to
// answer a question about containers nobody asked about. They load per row,
// on expand — see `loadUpdateNotes` (lib/dashboard/update-rows.ts).

export type UpdatesData = {
  rows: UpdateRow[]
  /** Rows whose verdict is `tag-moved` or `newer-tag`, updatable or not. */
  behind: number
  /** When the registry probe last ran. Null if it never has. */
  checkedAt: string | null
  /** True when the probe's answers are missing entirely, not merely old. */
  probeMissing: boolean
  /**
   * The bridge's current state, so a page opened mid-update joins the run
   * already in progress rather than offering to start a second one.
   */
  status: ImageUpdateStatus
  /** The engine's own pin — the card above the table. */
  engine: EngineFacts
  /**
   * The NixOS release this generation was built with, from the site export;
   * `facts` is null before the export carries the release in detail, and
   * `version` is the one string every export has.
   */
  nixos: { facts: NixosFacts | null; version: string | null }
}

// ── the engine itself ─────────────────────────────────────────────────────
//
// The one pin on the page that is not an image: the configuration's
// `daedalus` flake input, locked by rev. Its "registry" is the engine clone
// on the box — the input is `git+file://<clone>?ref=main`, so "latest" is
// that clone's `main` once it has been fast-forwarded from origin — and its
// update is the same shape as an image's: move the pin, build, switch, verify
// that the control plane came back, revert if it did not, push.
//
// Two snapshots answer where things stand, and neither is fetched for it:
// the repo snapshot publishes the lock's node, the workspace snapshot the
// clone's head, its dirtiness and how far it is behind the origin it last
// fetched (every 30 minutes). Either missing is "unknown" — never a guess.

/** Where the pinned engine stands against the clone, and the clone against origin. */
export type EngineVerdict =
  /** The clone's main is what the lock pins, and origin has nothing newer as of the last fetch. */
  | 'current'
  /** Origin has commits the clone has not taken; an update fast-forwards and pins them. */
  | 'behind-origin'
  /** The clone's main is past the lock — commits landed locally and were never pinned. */
  | 'unpinned'
  /** The lock, the clone, or both are not published. */
  | 'unknown'

export type EngineFacts = {
  /** The lock's `daedalus` node; null until the repo snapshot carries it. */
  pinned: EngineLock | null
  /** The engine's workspace clone; null when none is under the workspace root. */
  clone: Workspace | null
  verdict: EngineVerdict
  /** site.json's `developer.engineOverride` — the update is refused while it is set. */
  override: string | null
  status: EngineUpdateStatus
}

function engineVerdict(pinned: EngineLock | null, clone: Workspace | null): EngineVerdict {
  if (pinned === null || clone === null || clone.head === null) return 'unknown'
  if ((clone.behind ?? 0) > 0) return 'behind-origin'
  // The snapshot publishes a 12-character head; the lock a full rev.
  if (!pinned.rev.startsWith(clone.head)) return 'unpinned'
  return 'current'
}

async function loadEngine(): Promise<EngineFacts> {
  const [repo, workspaces, site, status] = await Promise.all([
    repoFacts(),
    readWorkspaces(),
    readCommittedSite(),
    readEngineUpdateStatus(),
  ])
  // Stale means the producer stopped, and a head from an unknown number of
  // hours ago is exactly the plausible-looking wrong answer "unknown" exists
  // to avoid — the same rule the provenance stamp applies (core/site).
  const pinned = repo.available && !repo.stale ? repo.data.engine : null
  const clone =
    workspaces.available && !workspaces.stale ? workspaceFor(ENGINE_REPO, workspaces.data) : null
  return {
    pinned,
    clone,
    verdict: engineVerdict(pinned, clone),
    override: site.ok ? site.value.doc.developer.engineOverride : null,
    status,
  }
}

export async function loadUpdates(): Promise<UpdatesData> {
  const [rows, status, engine, site] = await Promise.all([
    updateRows(),
    readImageUpdateStatus(),
    loadEngine(),
    siteIdentity(),
  ])

  const checked = rows.map((r) => r.freshness?.checkedAt).filter((c) => c !== undefined)

  return {
    rows,
    behind: rows.filter((r) => r.verdict === 'tag-moved' || r.verdict === 'newer-tag').length,
    checkedAt: checked.length === 0 ? null : (checked.sort().at(-1) ?? null),
    probeMissing: checked.length === 0,
    status,
    engine,
    nixos: { facts: site.data.nixos, version: site.data.nixosVersion },
  }
}
