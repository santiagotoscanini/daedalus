// "Is it worth updating?" — answered from the vendor's own release notes.
//
// Every service on the AI page is pinned: the flake names an image digest, or
// Lemonade sits on whatever the gaming PC last installed. Pinning is the right
// default, but it means nothing here is ever "automatically up to date" (see
// CLAUDE.md on `--pull missing`), so the update decision is a deliberate act —
// and the only thing that makes it a decision rather than a coin flip is
// reading what actually changed in between.
//
// So this fetches the releases BETWEEN what is running and what is current,
// inclusive of the running one. The running release answers "what did I last
// get", the ones above it answer "what am I missing", and one panel shows both
// without you opening four GitHub tabs.
//
// ── why there is a cache here, and only here ──────────────────────────────
//
// Unauthenticated GitHub allows 60 requests per hour per IP. A category page
// that asked on every render would exhaust that in a couple of minutes of
// clicking around and then show nothing at all — the worst failure mode, since
// it looks like the feature is broken rather than throttled. Release lists
// also change a handful of times a WEEK, so a cache costs nothing in accuracy.
//
// This is deliberately not in clients.ts: the coalescer there is explicitly
// not a cache, because every other number on this dashboard has to be live.
// Release history is the one upstream where staleness is free.

/**
 * How long a repo's release list is reused.
 *
 * Fifteen minutes against a ~60/hr budget means four repos cost 16 calls an
 * hour with the tab left open, which leaves the rest of the allowance for the
 * occasional cold start. Nothing on the shelf is ever more than one release
 * behind reality, and a release is a thing that happens weekly at best.
 */
const TTL_MS = 15 * 60_000

/**
 * How long to wait before trying again after GitHub says no.
 *
 * Shorter than the TTL, because a refusal is usually the rate-limit window
 * closing and those open on the hour — but not zero, which is what "retry on
 * every render" amounts to and is precisely how a window stays shut.
 *
 * The last good answer keeps being served throughout. Release history is not
 * a live number: a list that is an hour stale is still the right list, and
 * showing it beats replacing a full panel with an apology because one fetch
 * was throttled.
 */
const RETRY_MS = 90_000

/**
 * Bullets kept per section, and sections per release.
 *
 * These bodies are big — a LiteLLM release note runs to 44k characters and an
 * Open WebUI one to 115k — and all of it would be serialised into the page's
 * HTML for hydration. The point of the panel is "is there anything in here for
 * me", which the first few bullets of each section answer; the link on every
 * entry goes to the full text for when the answer is yes.
 */
const MAX_ITEMS = 8
const MAX_SECTIONS = 6

/** Releases rendered at once, newest first. A long gap is still a long read. */
const MAX_RELEASES = 8

export type ReleaseNote = {
  version: string
  date: string
  url: string
  sections: { name: string; items: string[] }[]
  /** True when the lists were cut — the entry says so rather than lying. */
  truncated: boolean
}

export type VersionGap = {
  /** What is running. Null when the service could not be asked. */
  installed: string | null
  /** The newest published release, whatever is running. */
  latest: string | null
  /** Releases strictly newer than `installed`, oldest first. */
  behind: string[]
  /** `installed` and everything above it, newest first. */
  releases: ReleaseNote[]
  /** Set when GitHub refused — rate limit, mostly. Shown instead of silence. */
  note: string | null
}

export const EMPTY_GAP: VersionGap = {
  installed: null,
  latest: null,
  behind: [],
  releases: [],
  note: null,
}

type GhRelease = {
  tag_name?: string
  name?: string
  body?: string
  html_url?: string
  published_at?: string
  draft?: boolean
  prerelease?: boolean
}

type Cached = {
  /** When the last SUCCESSFUL fetch landed. */
  at: number
  /** When the last attempt was made, successful or not. */
  tried: number
  releases: GhRelease[] | null
}

const cache = new Map<string, Cached>()

/**
 * A repo's published releases, newest first, at most once per `TTL_MS`.
 *
 * Two clocks, because success and failure want different treatment. Fresh
 * data is reused for the full TTL. A refusal does NOT discard what we already
 * had — it only marks that an attempt was made, so the next render serves the
 * previous answer and the retry waits out `RETRY_MS`.
 *
 * The failure mode this exists for is the unauthenticated rate limit: 60
 * requests an hour per IP, shared with anything else on this box that talks to
 * GitHub. Without stale-serving, exhausting it replaces every release panel on
 * the AI pages with an error for a quarter of an hour, which looks like the
 * feature is broken rather than like one fetch was throttled.
 */
async function releases(repo: string): Promise<GhRelease[] | null> {
  const hit = cache.get(repo)
  const now = Date.now()

  if (hit !== undefined) {
    const fresh = hit.releases !== null && now - hit.at < TTL_MS
    const backingOff = now - hit.tried < RETRY_MS
    if (fresh || backingOff) return hit.releases
  }

  try {
    const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=60`, {
      headers: { Accept: 'application/vnd.github+json' },
      signal: AbortSignal.timeout(6_000),
    })
    if (res.ok) {
      const out = (await res.json()) as GhRelease[]
      cache.set(repo, { at: now, tried: now, releases: out })
      return out
    }
  } catch {
    // Falls through to the same place a non-ok status does.
  }

  // Attempt recorded, previous answer (if any) kept.
  cache.set(repo, { at: hit?.at ?? 0, tried: now, releases: hit?.releases ?? null })
  return hit?.releases ?? null
}

/**
 * Semver-ish ordering, on the three numbers and nothing else.
 *
 * Deliberately not a full semver comparator: every tag reaching this has
 * already been stripped to digits and dots by the caller's `tag` pattern, and
 * a build/prerelease suffix is a reason to have dropped the release, not to
 * rank it.
 */
function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

export type GapOptions = {
  /**
   * Tag → version. n8n publishes `n8n@2.33.4`, everyone else `v1.2.3`, and
   * both repos also carry moving tags (`stable`, `beta`) that are not versions
   * at all — a pattern that fails to match is how those get dropped.
   */
  tag?: RegExp
  /**
   * Keep only releases on the running major.
   *
   * n8n publishes a 1.x LTS line alongside 2.x, interleaved by date. Without
   * this, a box on 2.33.2 is told it is "42 releases behind" because the list
   * includes every 1.123.x patch — a number that is both wrong and alarming.
   */
  sameMajor?: boolean
}

const DEFAULT_TAG = /^v?(\d+\.\d+\.\d+)$/

/**
 * What is running, what is current, and the notes in between.
 *
 * `installed` comes from the service itself wherever the service will say
 * (Lemonade's /health, LiteLLM's OpenAPI document, Open WebUI's version
 * endpoint) and from the flake where it will not (n8n's pinned tag). Either
 * way it is the version actually running, not a guess from the tag.
 */
export async function versionGap(
  repo: string,
  installed: string | null,
  opts: GapOptions = {},
): Promise<VersionGap> {
  const list = await releases(repo)
  if (list === null) {
    return {
      ...EMPTY_GAP,
      installed,
      note: 'GitHub did not answer — its unauthenticated rate limit is 60 requests an hour',
    }
  }

  const pattern = opts.tag ?? DEFAULT_TAG
  const major = installed?.split('.')[0]

  const parsed = list
    .filter((r) => r.draft !== true)
    .map((r) => {
      const version = pattern.exec(r.tag_name ?? '')?.[1]
      return version === undefined ? null : { ...r, version }
    })
    .filter((r): r is GhRelease & { version: string } => r !== null)
    .filter((r) => opts.sameMajor !== true || major === undefined || r.version.split('.')[0] === major)
    .sort((a, b) => cmp(b.version, a.version))

  // Prereleases are dropped from the CANDIDATE set but not from the notes.
  // They are not a thing to be told you are behind — n8n publishes a 2.34.x
  // beta line continuously, and counting it would make a perfectly current box
  // look neglected. But the version actually running here IS sometimes one of
  // them (n8n marked the 2.33.2 this box is pinned to as a prerelease), and
  // its notes are the "what did I last get" half of the panel.
  const stable = parsed.filter((r) => r.prerelease !== true)

  const latest = stable[0]?.version ?? null

  // Everything strictly above what is running, oldest first — the same reading
  // order as an upgrade path, which is what it is.
  const behind =
    installed === null ? []
    : stable
        .filter((r) => cmp(r.version, installed) > 0)
        .map((r) => r.version)
        .reverse()

  // The running release is included so the panel says what you last got when
  // there is nothing pending, rather than going blank on a healthy service.
  const wanted = new Set(installed === null ? behind : [...behind, installed])
  const releaseNotes = parsed
    .filter((r) => wanted.has(r.version))
    .slice(0, MAX_RELEASES)
    .map(
      (r): ReleaseNote => ({
        version: r.version,
        date: (r.published_at ?? '').slice(0, 10),
        url: r.html_url ?? `https://github.com/${repo}/releases`,
        ...parseBody(r.body ?? ''),
      }),
    )

  return { installed, latest, behind, releases: releaseNotes, note: null }
}

/**
 * A GitHub release body — Markdown — into the same shape the wiki-sourced
 * Factorio changelog produces, so one component renders both.
 *
 * These are hand-written by four different projects and the only structure
 * they reliably share is "headings, then bullets under them". So that is all
 * this looks for: any `##`-level heading starts a section, any `-`/`*` line is
 * an item, and prose before the first heading becomes a lead section rather
 * than being dropped — several of these projects put the actual summary there.
 */
function parseBody(md: string): { sections: ReleaseNote['sections']; truncated: boolean } {
  const sections: ReleaseNote['sections'] = []
  let truncated = false

  let name = 'Summary'
  let items: string[] = []

  const flush = () => {
    // Boilerplate GitHub appends to every generated note. "New Contributors"
    // is four lines of "@someone made their first contribution in <url>",
    // which is a lovely thing for the project and says nothing about whether
    // to take the update — and it was pushing a real section past the cap.
    if (items.length === 0 || /contributors|full changelog|sponsors/i.test(name)) {
      items = []
      return
    }
    if (items.length > MAX_ITEMS) truncated = true
    sections.push({ name, items: items.slice(0, MAX_ITEMS) })
    items = []
  }

  for (const raw of md.split('\n')) {
    const line = raw.trim()

    const heading = /^#{2,4}\s+(.+)$/.exec(line)
    if (heading?.[1] !== undefined) {
      flush()
      name = clean(heading[1]).slice(0, 60)
      continue
    }

    // A bullet, or a paragraph line in the lead section. Numbered lists show
    // up in these bodies too and read as bullets once the marker is gone.
    const bullet = /^[-*+]\s+(.+)$/.exec(line) ?? /^\d+[.)]\s+(.+)$/.exec(line)
    const text = bullet?.[1] ?? (sections.length === 0 && name === 'Summary' ? line : '')
    if (text === '') continue

    const cleaned = clean(text)
    // Skip what is furniture rather than content: badge/image lines, the
    // "Full Changelog" footer GitHub generates, and bare links.
    if (cleaned === '' || cleaned.length < 3) continue
    if (/^full changelog\b/i.test(cleaned)) continue

    items.push(cleaned.length > 400 ? `${cleaned.slice(0, 400)}…` : cleaned)
  }
  flush()

  if (sections.length > MAX_SECTIONS) truncated = true
  return { sections: sections.slice(0, MAX_SECTIONS), truncated }
}

/** Markdown → plain text. Only the markup these four projects actually use. */
function clean(s: string): string {
  return (
    s
      // Images first: `![alt](url)` would otherwise leave a stray `!`.
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/<[^>]+>/g, '')
      .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
      .replace(/\*\*([^*]*)\*\*/g, '$1')
      .replace(/(?<!\w)_([^_]+)_(?!\w)/g, '$1')
      // `by @someone in https://github.com/…/pull/123` — the attribution
      // footer autogenerated notes append to every single line. It doubles the
      // length of a bullet and says nothing about what changed.
      .replace(/\s+by\s+@[\w-]+\s+in\s+\S+$/i, '')
      .replace(/\s+/g, ' ')
      .trim()
  )
}
