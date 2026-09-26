import {
  imagePins,
  type ManualPin,
  manualPins,
  type PinnedIn,
} from '../../host/contract/domains/images'
import { type CommitGap, commitsSince, EMPTY_GAP, type VersionGap, versionGap } from './github'
import { type ReleaseSource, releaseSourceFor } from './image-repos'
import { type ImageFreshness, imageFreshness, imageVersion, type RunningVersion } from './images'

// One pin as an update decision: what runs, what the registry has, and — for
// a container's digest pin — what the button would move it to.
//
// System › Updates draws every pin on the box from this; a service tab draws
// the few containers it fronts from the same rows, so a verdict never reads
// one way on the fleet page and another on the service's own.
//
// Two kinds of row. A CONTAINER row is a `:tag@sha256:` pin the Update button
// rewrites. A MANUAL row is a pin that is not a container's own image
// (fleet.manualPins: a local build's base, a build tool, a source commit) —
// the same verdict where a registry can give one, and the file a bump edits.
// A manual row whose base the configuration pins is `updatable` too: the
// button moves it under the pin's id, through the same agent.
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

type RowBase = {
  /** The container, or a manual pin's id. */
  container: string
  running: RunningVersion
  freshness: ImageFreshness | null
  verdict: UpdateVerdict
  /** Whether expanding this row would find any notes to show. */
  hasNotes: boolean
}

/** What the Update button needs to move a pin — both kinds of row carry it. */
type UpdatePolicy = {
  /** The tag this row would move to by default. Null when there is none. */
  target: string | null
  /** Same-shape tags, newest first — what the picker offers. */
  candidates: string[]
  updatable: boolean
  lockstep: string[]
  ceremony: string | null
  /** `ceremony` for a move to a new major only (lib/image-ceremony.ts). */
  majorCeremony: string | null
}

/** A container's digest pin — the row with the button. */
export type ContainerRow = RowBase &
  UpdatePolicy & {
    kind: 'container'
    /** `<repo>:<tag>` — the ref the registry was asked about. */
    image: string
    repo: string
    tag: string
    digest: string
  }

/**
 * A pin that is not a container's own image: the row names the file a bump
 * edits, and — when `updatable`, a base the configuration pins — carries the
 * button as well.
 */
export type ManualRow = RowBase &
  UpdatePolicy & {
    kind: 'manual'
    /** `<repo>:<tag>`, or null for a commit or a release number. */
    image: string | null
    /** The image's tag; null for a commit or a release number. */
    tag: string | null
    digest: string | null
    pinnedIn: PinnedIn
    /** Versions that move with this one, as a set. */
    parts: Record<string, string>
    containers: string[]
    note: string | null
  }

export type UpdateRow = ContainerRow | ManualRow

/**
 * Where the button goes by default. A moved channel updates to the SAME tag —
 * there is no other name for where it is going, and the digest is the whole
 * change. A frozen tag updates to the highest of its shape, when there is one.
 */
function targetOf(verdict: UpdateVerdict, tag: string, f: ImageFreshness | null): string | null {
  return verdict === 'tag-moved' ? tag : (f?.newerTag ?? null)
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

function byVerdict(a: RowBase, b: RowBase): number {
  return ORDER[a.verdict] - ORDER[b.verdict] || a.container.localeCompare(b.container)
}

/**
 * The rows for every pin, or only for `containers` when given — in that case
 * a name with no digest pin is simply absent, never an error.
 */
export async function updateRows(containers?: readonly string[]): Promise<ContainerRow[]> {
  const pins = await imagePins()
  const wanted =
    containers === undefined
      ? Object.entries(pins)
      : Object.entries(pins).filter(([c]) => containers.includes(c))

  const rows = await Promise.all(
    wanted.map(async ([container, pin]): Promise<ContainerRow> => {
      const [running, freshness, source] = await Promise.all([
        imageVersion(container),
        imageFreshness(container),
        releaseSourceFor(container),
      ])

      const verdict = verdictOf(freshness)

      return {
        kind: 'container',
        container,
        image: pin.image,
        repo: pin.repo,
        tag: pin.tag,
        digest: pin.digest,
        running,
        freshness,
        verdict,
        target: targetOf(verdict, pin.tag, freshness),
        candidates: freshness?.candidates ?? [],
        updatable: pin.updatable,
        lockstep: pin.lockstep,
        ceremony: pin.ceremony,
        majorCeremony: pin.majorCeremony,
        hasNotes: source !== null,
      }
    }),
  )

  return rows.sort(byVerdict)
}

// ── the pins moved by hand ────────────────────────────────────────────────

/**
 * Where a manual pin's notes live: its own `upstream`, else whatever the
 * first container it builds already reads. A pin with neither has no notes.
 */
async function manualSource(pin: ManualPin): Promise<ReleaseSource | null> {
  if (pin.upstream !== null) {
    return pin.branch === null ? { repo: pin.upstream } : { repo: pin.upstream, branch: pin.branch }
  }
  const first = pin.containers[0]
  return first === undefined ? null : releaseSourceFor(first)
}

/** A commit is shown short; the full one is what the notes compare from. */
function shownVersion(pin: ManualPin): string {
  return pin.branch === null ? pin.version : pin.version.slice(0, 7)
}

/**
 * Every hand-moved pin on the box, behind first.
 *
 * The verdict is the registry probe's where the pin is an image (it asks
 * about those under the pin's id); a commit or a release number has no
 * registry, so its verdict is `unknown` and its notes say how far behind it is.
 */
export async function manualRows(): Promise<ManualRow[]> {
  const pins = await manualPins()

  const rows = await Promise.all(
    Object.entries(pins).map(async ([id, pin]): Promise<ManualRow> => {
      const [freshness, source] = await Promise.all([
        pin.digest === null ? Promise.resolve(null) : imageFreshness(id),
        manualSource(pin),
      ])
      const version = shownVersion(pin)
      const verdict = verdictOf(freshness)
      // Only a base the configuration pins is moved from here; the host agent
      // decides that again against its own registry before touching anything.
      const updatable = pin.updatable && pin.tag !== null
      return {
        kind: 'manual',
        container: id,
        image: pin.image,
        tag: pin.tag,
        digest: pin.digest,
        running: {
          version,
          source: 'pin',
          revision: pin.branch === null ? null : version,
        },
        freshness,
        verdict,
        hasNotes: source !== null,
        target: updatable && pin.tag !== null ? targetOf(verdict, pin.tag, freshness) : null,
        candidates: updatable ? (freshness?.candidates ?? []) : [],
        updatable,
        lockstep: [],
        ceremony: pin.ceremony,
        majorCeremony: pin.majorCeremony,
        pinnedIn: pin.pinnedIn,
        parts: pin.parts,
        containers: pin.containers,
        note: pin.note,
      }
    }),
  )

  return rows.sort(byVerdict)
}

// ── the expanded row ──────────────────────────────────────────────────────

/**
 * The notes for ONE row, fetched when it is opened.
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

/** `container` is a container name or a manual pin's id; manual ids win. */
export async function loadUpdateNotes(container: string): Promise<UpdateNotes> {
  const manual = (await manualPins())[container]
  if (manual !== undefined) {
    const source = await manualSource(manual)
    if (source === null) return { container, gap: null, build: null, repo: null }
    // A pin's own branch compares its own commit; a borrowed source that
    // tracks a branch compares the commit the container's image was built from.
    const revision =
      manual.upstream !== null
        ? manual.version
        : (await imageVersion(manual.containers[0] ?? container)).revision
    return notesFrom(container, source, manual.version, revision)
  }

  const source = await releaseSourceFor(container)
  if (source === null) return { container, gap: null, build: null, repo: null }
  const { version, revision } = await imageVersion(container)
  return notesFrom(container, source, version, revision)
}

async function notesFrom(
  container: string,
  source: ReleaseSource,
  version: string | null,
  revision: string | null,
): Promise<UpdateNotes> {
  if (source.branch !== undefined) {
    return {
      container,
      gap: null,
      build: await commitsSince(source.repo, revision, source.branch),
      repo: source.repo,
    }
  }

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
