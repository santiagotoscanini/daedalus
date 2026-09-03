import { imagePins } from '../../../contract/domains/images'
import { type ImageUpdateStatus, readImageUpdateStatus } from '../../../image-update'
import { type CommitGap, commitsSince, EMPTY_GAP, type VersionGap, versionGap } from '../../github'
import { releaseSourceFor } from '../../image-repos'
import {
  type ImageFreshness,
  imageFreshness,
  imageVersion,
  type RunningVersion,
} from '../../images'

// Every digest-pinned container on the box, and whether it is behind.
//
// The page this feeds is the only one in the app whose subject is not a
// service. Sixty-five containers, and roughly a third of them — the exporters,
// the redis and postgres sidecars, the *arr janitors, the exporters behind one
// dashboard — have no tab and never will: nobody opens scraparr, and
// a Board about node-exporter would say nothing a person wants. What they DO
// have is a pin that ages exactly like Jellyfin's, and until this page there
// was nowhere in the app where that fact appeared at all.
//
// ── it costs no network ───────────────────────────────────────────────────
//
// Everything here is a local read: the pins come from the nix export, the
// verdicts from the daily registry probe, the running versions from image
// labels — three snapshot files, all already cached by their own modules. That
// is what makes a table of sixty-five rows reasonable to render at all.
//
// The changelogs are NOT here, deliberately. Sixty-five GitHub release lists
// on every page load would spend the hourly budget in one visit to answer a
// question about sixty-four containers nobody asked about. They load per row,
// on expand — see `loadUpdateNotes`.

/** What the registry and the flake, between them, say about one pin. */
export type UpdateVerdict =
  /** The tag moved and the pin did not — a channel pin with a newer image. */
  | 'tag-moved'
  /** The tag is frozen, but a higher tag of the same shape exists. */
  | 'newer-tag'
  /** Pin and tag agree, and nothing higher was published. */
  | 'current'
  /** The probe has not run, went stale, or the registry refused. */
  | 'unknown'

export type UpdateRow = {
  container: string
  /** `<repo>:<tag>` — the ref the registry was asked about. */
  image: string
  repo: string
  tag: string
  digest: string
  running: RunningVersion
  freshness: ImageFreshness | null
  verdict: UpdateVerdict
  /** The tag this row would move to by default. Null when there is none. */
  target: string | null
  /** Same-shape tags, newest first — what the picker offers. */
  candidates: string[]
  updatable: boolean
  lockstep: string[]
  ceremony: string | null
  /** Whether expanding this row would find any notes to show. */
  hasNotes: boolean
}

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
}

function verdictOf(f: ImageFreshness | null): UpdateVerdict {
  if (f === null || f.error !== null) return 'unknown'
  if (f.moved) return 'tag-moved'
  if (f.newerTag !== null) return 'newer-tag'
  return 'current'
}

/**
 * Behind first, then by name.
 *
 * A verdict order rather than an alphabet, because the question the page
 * exists to answer is "what needs attention" — and sixty-five alphabetised
 * rows answer it by making you read all sixty-five. `tag-moved` outranks
 * `newer-tag` because a moved channel is a pin that has silently stopped
 * matching what its own tag means, which is the sharper of the two.
 */
const ORDER: Record<UpdateVerdict, number> = {
  'tag-moved': 0,
  'newer-tag': 1,
  unknown: 2,
  current: 3,
}

export async function loadUpdates(): Promise<UpdatesData> {
  const [pins, status] = await Promise.all([imagePins(), readImageUpdateStatus()])

  const rows = await Promise.all(
    Object.entries(pins).map(async ([container, pin]): Promise<UpdateRow> => {
      const [running, freshness, source] = await Promise.all([
        imageVersion(container),
        imageFreshness(container),
        releaseSourceFor(container),
      ])

      const verdict = verdictOf(freshness)

      return {
        container,
        image: pin.image,
        repo: pin.repo,
        tag: pin.tag,
        digest: pin.digest,
        running,
        freshness,
        verdict,
        // A moved channel updates to the SAME tag — there is no other name for
        // where it is going, and the digest is the whole change. A frozen tag
        // updates to the highest of its shape, when there is one.
        target: verdict === 'tag-moved' ? pin.tag : (freshness?.newerTag ?? null),
        candidates: freshness?.candidates ?? [],
        updatable: pin.updatable,
        lockstep: pin.lockstep,
        ceremony: pin.ceremony,
        hasNotes: source !== null,
      }
    }),
  )

  rows.sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.container.localeCompare(b.container))

  const checked = rows.map((r) => r.freshness?.checkedAt).filter((c) => c !== undefined)

  return {
    rows,
    behind: rows.filter((r) => r.verdict === 'tag-moved' || r.verdict === 'newer-tag').length,
    checkedAt: checked.length === 0 ? null : (checked.sort().at(-1) ?? null),
    probeMissing: checked.length === 0,
    status,
  }
}

// ── the expanded row ──────────────────────────────────────────────────────

/**
 * The notes for ONE container, fetched when its row is opened.
 *
 * Two shapes, exactly as the Changelog board takes them: a release gap for a
 * project that cuts releases, a commit gap for an image that tracks a branch.
 * Which applies is a property of the project, not a choice — see
 * lib/dashboard/image-repos.ts.
 */
export type UpdateNotes = {
  container: string
  gap: VersionGap | null
  build: CommitGap | null
  /** The repo the notes came from, for the "we read this" line. */
  repo: string | null
}

export async function loadUpdateNotes(container: string): Promise<UpdateNotes> {
  const source = await releaseSourceFor(container)
  if (source === null) return { container, gap: null, build: null, repo: null }

  if (source.branch !== undefined) {
    const { revision } = await imageVersion(container)
    return {
      container,
      gap: null,
      build: await commitsSince(source.repo, revision, source.branch),
      repo: source.repo,
    }
  }

  const { version } = await imageVersion(container)
  return {
    container,
    gap:
      version === null && source.opts?.notesWhenUnknown !== true
        ? {
            ...EMPTY_GAP,
            note: 'this pin names a channel, so there is no version to compare against',
          }
        : await versionGap(source.repo, version, source.opts),
    build: null,
    repo: source.repo,
  }
}
