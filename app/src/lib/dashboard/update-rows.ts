import { imagePins } from '../../host/contract/domains/images'
import { type CommitGap, commitsSince, EMPTY_GAP, type VersionGap, versionGap } from './github'
import { releaseSourceFor } from './image-repos'
import { type ImageFreshness, imageFreshness, imageVersion, type RunningVersion } from './images'

// One digest-pinned container as an update decision: what runs, what the
// registry has, and what the button would move it to.
//
// System › Updates draws every pin on the box from this; a service tab draws
// the few containers it fronts from the same rows, so a verdict never reads
// one way on the fleet page and another on the service's own.
//
// Local reads only — the pins from the nix export, the verdicts from the daily
// registry probe, the running versions from image labels. The changelogs are
// NOT here: they load per row, on expand (`loadUpdateNotes`), because a
// GitHub release list per pin on every page load would spend the hourly
// budget in one visit.

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

function verdictOf(f: ImageFreshness | null): UpdateVerdict {
  if (f === null || f.error !== null) return 'unknown'
  if (f.moved) return 'tag-moved'
  if (f.newerTag !== null) return 'newer-tag'
  return 'current'
}

/**
 * Behind first, then by name.
 *
 * A verdict order rather than an alphabet, because the question a list of pins
 * answers is "what needs attention". `tag-moved` outranks `newer-tag` because
 * a moved channel is a pin that has silently stopped matching what its own
 * tag means, which is the sharper of the two.
 */
const ORDER: Record<UpdateVerdict, number> = {
  'tag-moved': 0,
  'newer-tag': 1,
  unknown: 2,
  current: 3,
}

/**
 * The rows for every pin, or only for `containers` when given — in that case
 * a name with no digest pin is simply absent, never an error.
 */
export async function updateRows(containers?: readonly string[]): Promise<UpdateRow[]> {
  const pins = await imagePins()
  const wanted =
    containers === undefined
      ? Object.entries(pins)
      : Object.entries(pins).filter(([c]) => containers.includes(c))

  const rows = await Promise.all(
    wanted.map(async ([container, pin]): Promise<UpdateRow> => {
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

  return rows.sort(
    (a, b) => ORDER[a.verdict] - ORDER[b.verdict] || a.container.localeCompare(b.container),
  )
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
