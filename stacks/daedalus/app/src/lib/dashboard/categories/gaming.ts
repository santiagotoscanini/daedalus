// The Gaming category — today that is one Factorio server.
//
// Its own page rather than a corner of Home because the questions are its
// own: which version is running, can the clients on the sofa still join it,
// and what has the vendor shipped since. A Minecraft server would land here
// beside it without changing any of that.
//
// ── where the version facts come from ─────────────────────────────────────
//
// ofsm does not manage the game version. It downloads exactly
// $FACTORIO_VERSION on every container start, so the string pinned in
// stacks/factorio/factorio.nix IS the running version — it reaches this file
// through the container env rather than being read back off the server, which
// has no unauthenticated endpoint to read it from anyway.
//
// Everything about what is CURRENT comes from Wube, unauthenticated:
//
//   /api/latest-releases          stable + experimental, per build
//   updater.../get-available-versions
//                                 the whole upgrade graph, which is what lets
//                                 this count the releases between the pinned
//                                 version and stable rather than just saying
//                                 "newer exists"
//   /blog/rss                     the devs' own feed: release announcements
//                                 and Friday Facts, which is the closest thing
//                                 to a changelog that is machine-readable

import { getJson, promScalar } from '../clients'

export type GamingData = {
  factorio: {
    /** Pinned in nix, downloaded on every container start — so, running. */
    installed: string | null
    stable: string | null
    experimental: string | null
    /** Releases between `installed` and `stable`, oldest first. */
    behind: string[]
    /** How the game is reached, which is not through traefik. */
    connect: string
    port: number
    /** Whether the admin UI is answering, from gatus. */
    adminUp: boolean | null
  }
  /** The devs' feed — release posts and Friday Facts, newest first. */
  news: { title: string; url: string; date: string; kind: 'release' | 'fff' | 'post' }[]
}

const PORT = 34197

export async function loadGaming(): Promise<GamingData> {
  const installed = process.env.FACTORIO_VERSION ?? null

  const [releases, graph, feed, adminUp] = await Promise.all([
    getJson<{ stable?: { headless?: string }; experimental?: { headless?: string } }>(
      'https://factorio.com/api/latest-releases',
    ),
    getJson<Record<string, ({ from?: string; to?: string } & { stable?: string })[]>>(
      'https://updater.factorio.com/get-available-versions',
    ),
    fetchFeed(),
    promScalar('gatus_results_endpoint_success{name="factorio-admin"}'),
  ])

  const stable = releases?.stable?.headless ?? null
  const experimental = releases?.experimental?.headless ?? null

  return {
    factorio: {
      installed,
      stable,
      experimental,
      behind: chain(graph?.['core-linux_headless64'] ?? [], installed, stable),
      // NOT the admin hostname: the game speaks its own UDP protocol straight
      // to the router-forwarded port and never touches traefik. `s2` is the
      // DDNS name that tracks this house's WAN address, so it is the thing a
      // player outside the LAN actually types.
      connect: `s2.toscanini.me:${String(PORT)}`,
      port: PORT,
      adminUp: adminUp === null ? null : adminUp === 1,
    },
    news: feed,
  }
}

/**
 * The releases between what is installed and what is stable.
 *
 * Wube publishes the upgrade graph as `{from, to}` pairs, which is exactly a
 * linked list — walking it gives the real sequence rather than a numeric
 * comparison, so a version that was pulled shows up as a gap rather than as a
 * wrong count. Bounded at 40 hops so a badly-pinned version cannot spin.
 */
function chain(
  pairs: ({ from?: string; to?: string } & { stable?: string })[],
  from: string | null,
  to: string | null,
): string[] {
  if (from === null || to === null || from === to) return []
  const next = new Map<string, string>()
  for (const p of pairs) {
    if (p.from !== undefined && p.to !== undefined) next.set(p.from, p.to)
  }
  const out: string[] = []
  let at = from
  for (let i = 0; i < 40; i++) {
    const step = next.get(at)
    if (step === undefined) break
    out.push(step)
    if (step === to) return out
    at = step
  }
  // Ran off the end of the graph without reaching stable: report the target
  // alone rather than a chain that does not actually lead there.
  return [to]
}

/**
 * factorio.com/blog/rss, parsed with regexes rather than an XML dependency.
 *
 * The feed is small, fixed-shape Atom from one publisher. A parser would be a
 * dependency in a container that reparses its whole module graph on a cold
 * load, to read three fields.
 */
async function fetchFeed(): Promise<GamingData['news']> {
  try {
    const res = await fetch('https://factorio.com/blog/rss', {
      signal: AbortSignal.timeout(4_000),
    })
    if (!res.ok) return []
    const xml = await res.text()

    return [...xml.matchAll(/<entry[^>]*>([\s\S]*?)<\/entry>/g)]
      .map((m) => {
        const body = m[1] ?? ''
        const title = /<title[^>]*>([\s\S]*?)<\/title>/.exec(body)?.[1]?.trim() ?? ''
        const url = /<link[^>]*href="([^"]+)"/.exec(body)?.[1] ?? 'https://factorio.com/blog'
        const date = (/<updated>([^<]+)<\/updated>/.exec(body)?.[1] ?? '').slice(0, 10)
        return {
          title: decode(title),
          url,
          date,
          // A release post is the one entry type that is actually a changelog,
          // so it is worth telling apart from a Friday Facts.
          kind:
            /version\s+\d|released/i.test(title) ? ('release' as const)
            : /friday facts/i.test(title) ? ('fff' as const)
            : ('post' as const),
        }
      })
      .filter((e) => e.title !== '')
      .slice(0, 6)
  } catch {
    return []
  }
}

function decode(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
}
