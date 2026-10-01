import { swrCache } from '../cache'
import { getJson } from '../http'
import { githubHeaders } from './github'

// The current stable release of each Chromium-based browser, from the
// vendor's own feed, so a node's Chromium tab can say whether the browser
// it has is the one the vendor is shipping. Three feeds are machine-
// readable and answer this box: Google's VersionHistory API, Microsoft's
// Edge update service, and Brave's GitHub releases. Arc publishes no feed
// this box can reach, and Vivaldi and Opera are not asked; those show
// their installed version and stop.
//
// Cached six hours in this process, per (kind, platform). A feed that does
// not answer leaves `latest` null with the reason, and a stale answer is
// kept for the day rather than dropped.

export type BrowserLatest = {
  kind: string
  /** "154.0.8037.58", or null when the feed did not answer. */
  latest: string | null
  /** ISO date the vendor published it, where the feed says. */
  publishedAt: string | null
  source: string
  error: string | null
}

// A good answer holds for six hours; a feed that failed is asked again on the
// next read, and its last good answer is shown meanwhile, with the failure.
const CACHE = swrCache({ ttlMs: 6 * 3600_000 })

/** The vendor's platform name for a node's OS and architecture. */
function chromePlatform(os: string, arch: string): string {
  if (os === 'macos') return /arm|aarch/i.test(arch) ? 'mac_arm64' : 'mac'
  return /arm|aarch/i.test(arch) ? 'win_arm64' : 'win64'
}

async function chrome(os: string, arch: string): Promise<BrowserLatest> {
  const platform = chromePlatform(os, arch)
  const source = `https://versionhistory.googleapis.com/v1/chrome/platforms/${platform}/channels/stable/versions`
  const body = await getJson<{ versions?: { version?: string }[] }>(`${source}?pageSize=1`)
  const v = body?.versions?.[0]?.version ?? null
  return {
    kind: 'chrome',
    latest: v,
    publishedAt: null,
    source,
    error: v === null ? 'VersionHistory did not answer' : null,
  }
}

type EdgeProduct = {
  Product?: string
  Releases?: {
    Platform?: string
    Architecture?: string
    ProductVersion?: string
    PublishedTime?: string
  }[]
}

async function edge(os: string, arch: string): Promise<BrowserLatest> {
  const source = 'https://edgeupdates.microsoft.com/api/products?view=enterprise'
  const body = await getJson<EdgeProduct[]>(source)
  const platform = os === 'macos' ? 'MacOS' : 'Windows'
  const want = os === 'macos' ? 'universal' : /arm|aarch/i.test(arch) ? 'arm64' : 'x64'
  const stable = body?.find((p) => p.Product === 'Stable')
  const rel = stable?.Releases?.find(
    (r) => r.Platform === platform && (r.Architecture ?? '').toLowerCase() === want,
  )
  return {
    kind: 'edge',
    latest: rel?.ProductVersion ?? null,
    publishedAt: rel?.PublishedTime ?? null,
    source,
    error: rel === undefined ? 'the Edge update service did not answer' : null,
  }
}

async function brave(): Promise<BrowserLatest> {
  const source = 'https://api.github.com/repos/brave/brave-browser/releases/latest'
  const body = await getJson<{ tag_name?: string; published_at?: string }>(source, {
    headers: await githubHeaders(),
  })
  // Brave's tag is "v1.95.104"; the browser reports "1.95.104" (its own
  // number) beside a Chromium number it does not put in the bundle version.
  const v = body?.tag_name?.replace(/^v/, '') ?? null
  return {
    kind: 'brave',
    latest: v,
    publishedAt: body?.published_at ?? null,
    source,
    error: v === null ? 'GitHub did not answer' : null,
  }
}

/** Newest stable for each kind the node reported, in one round. */
export async function browserLatest(
  kinds: string[],
  os: string,
  arch: string,
): Promise<BrowserLatest[]> {
  const out: BrowserLatest[] = []
  for (const kind of [...new Set(kinds)]) {
    const reader =
      kind === 'chrome'
        ? () => chrome(os, arch)
        : kind === 'edge'
          ? () => edge(os, arch)
          : kind === 'brave'
            ? brave
            : null
    if (reader === null) continue
    // What this read's own attempt answered, when it was not a good answer.
    const attempt: { failed: BrowserLatest | null } = { failed: null }
    const value = await CACHE.get(`${kind}/${os}/${arch}`, async () => {
      try {
        const v = await reader()
        if (v.error === null) return v
        attempt.failed = v
      } catch (e) {
        const error = e instanceof Error ? e.message : String(e)
        attempt.failed = { kind, latest: null, publishedAt: null, source: '', error }
      }
      return null
    })
    const failed = attempt.failed
    if (value !== null) out.push(failed === null ? value : { ...value, error: failed.error })
    else if (failed !== null) out.push(failed)
  }
  return out
}
