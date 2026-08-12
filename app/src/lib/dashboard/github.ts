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

import { swrCache } from '../cache'
import { key } from '../keys'

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

/**
 * Authenticated when a token is present, which is only about the rate limit.
 *
 * Everything read here is PUBLIC — four projects' release notes — so the token
 * buys no access, just headroom: 60 requests an hour per IP unauthenticated
 * against 5000 authenticated. It is the GHCR pull credential, re-shaped into
 * this env var by a boot oneshot (see stacks/daedalus/daedalus.nix), so there
 * is no second secret to rotate.
 *
 * Absent is a supported state, not a misconfiguration: without it this falls
 * back to the unauthenticated budget, which normal use spends about a quarter
 * of. So the token expiring costs nothing here — it is caught by the deploys
 * that actually need it.
 */
function auth(): Record<string, string> {
  const token = key('GITHUB_TOKEN')
  return {
    Accept: 'application/vnd.github+json',
    ...(token === '' ? {} : { Authorization: `Bearer ${token}` }),
  }
}

// The two-clock stale-serving contract now lives in lib/cache.ts — it was
// written here first, for the unauthenticated rate limit: 60 requests an hour
// per IP, shared with anything else on this box that talks to GitHub.
const cache = swrCache({ ttlMs: TTL_MS, retryMs: RETRY_MS })

/** A repo's published releases, newest first, at most once per `TTL_MS`. */
async function releases(repo: string): Promise<GhRelease[] | null> {
  return cache.get(`releases:${repo}`, async (): Promise<GhRelease[] | null> => {
    try {
      const res = await fetch(`https://api.github.com/repos/${repo}/releases?per_page=60`, {
        headers: auth(),
        signal: AbortSignal.timeout(6_000),
      })
      if (res.ok) return (await res.json()) as GhRelease[]
    } catch {
      // Falls through to the same place a non-ok status does.
    }
    return null
  })
}

/**
 * Semver-ish ordering, on the numbers and nothing else.
 *
 * Deliberately not a full semver comparator: every tag reaching this has
 * already been stripped to digits and dots by the caller's `tag` pattern, and
 * a build/prerelease suffix is a reason to have dropped the release, not to
 * rank it.
 *
 * As many segments as the longer of the two, rather than three, because the
 * *arrs number their builds: Sonarr ships `4.0.19.2979` and Radarr
 * `6.3.0.10514`, where the fourth segment is the only one that moves between
 * most releases. Stopping at three would rank every build of a point release
 * equal, which reads as "current" on a box that is nine builds behind. A
 * missing segment counts as zero, so three-part versions compare exactly as
 * they did.
 */
export function cmp(a: string, b: string): number {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
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
  /**
   * Show the newest releases even when what is RUNNING cannot be named.
   *
   * For an image that is a digest-pinned `:latest` whose software reports no
   * version anywhere — gluetun-exporter is the case. Normally an unknown
   * `installed` means an empty panel, which is correct (nothing can be said to
   * be pending) and useless. This says the other true thing instead: here is
   * what has been published, and no, we cannot tell you which of it you have.
   * The panel is responsible for saying that second part out loud.
   */
  notesWhenUnknown?: boolean
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
    .filter(
      (r) => opts.sameMajor !== true || major === undefined || r.version.split('.')[0] === major,
    )
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
    installed === null
      ? []
      : stable
          .filter((r) => cmp(r.version, installed) > 0)
          .map((r) => r.version)
          .reverse()

  // The running release is included so the panel says what you last got when
  // there is nothing pending, rather than going blank on a healthy service.
  const wanted = new Set(
    installed !== null
      ? [...behind, installed]
      : opts.notesWhenUnknown === true
        ? stable.slice(0, MAX_RELEASES).map((r) => r.version)
        : behind,
  )
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

/** One commit, as an image built off a moving branch can be compared to. */
export type Commit = { sha: string; date: string; subject: string; url: string }

export type CommitGap = {
  /** The commit the running image was built from, short. */
  running: string | null
  /** When that build was cut, `YYYY-MM-DD`. */
  builtOn: string | null
  /** Commits on the branch since it, oldest first. */
  behind: Commit[]
  /** Set when GitHub would not answer, or the sha is unknown to it. */
  note: string | null
}

export const EMPTY_COMMITS: CommitGap = { running: null, builtOn: null, behind: [], note: null }

/**
 * What a branch has picked up since the commit an image was built from.
 *
 * The counterpart to `versionGap`, for the images that track a moving branch
 * instead of a release. gluetun is the case in point and the reason this
 * exists: the box runs a digest-pinned `:latest`, which is master, and master
 * has DIVERGED from the v3.41.x release line — v3.41.2 ships an acknowledged
 * port-forwarding deadlock this box would trip. So a release list here would
 * not merely be uninformative, it would advise a downgrade into a known bug.
 * Commits since the build is the true answer to "what would I get if I
 * repulled", which is the only upgrade question this image has.
 *
 * Same two-clock cache as `releases` for the same reason — see lib/cache.ts.
 */
export async function commitsSince(
  repo: string,
  sha: string | null,
  branch = 'master',
): Promise<CommitGap> {
  if (sha === null || sha === '') return EMPTY_COMMITS

  const gap = await cache.get(
    `compare:${repo}@${sha}...${branch}`,
    async (): Promise<CommitGap | null> => {
      // Plain fetch on a six-second budget, not `getJson` — same reason
      // `releases` does it: getJson's ladder starts at 400ms, which is tuned
      // for a stalled rootless-netns socket on this box and is far under a
      // round trip to github.com. Through that helper this call failed every
      // time.
      type Compare = {
        commits?: {
          sha?: string
          html_url?: string
          commit?: { author?: { date?: string }; message?: string }
        }[]
        base_commit?: { commit?: { author?: { date?: string } } }
      }
      let body: Compare | null = null
      try {
        const res = await fetch(`https://api.github.com/repos/${repo}/compare/${sha}...${branch}`, {
          headers: auth(),
          signal: AbortSignal.timeout(6_000),
        })
        if (res.ok) body = (await res.json()) as Compare
      } catch {
        // Falls through to the same place a non-ok status does.
      }
      if (body === null) return null

      return {
        running: sha,
        builtOn: body.base_commit?.commit?.author?.date?.slice(0, 10) ?? null,
        // Oldest first, matching how the release chain reads on the AI tabs.
        behind: (body.commits ?? []).map((c) => ({
          sha: (c.sha ?? '').slice(0, 7),
          date: c.commit?.author?.date?.slice(0, 10) ?? '',
          // The subject line only. A gluetun commit body is a diff summary and
          // there are dozens of them; the subject is what a person scans.
          subject: (c.commit?.message ?? '').split('\n')[0] ?? '',
          url: c.html_url ?? `https://github.com/${repo}/commit/${c.sha ?? ''}`,
        })),
        note: null,
      }
    },
  )

  return gap ?? { ...EMPTY_COMMITS, running: sha, note: 'GitHub would not answer' }
}
