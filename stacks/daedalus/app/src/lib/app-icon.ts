// Each app's own icon, taken from the app.
//
// Every app here already publishes an icon — it is what the browser tab shows
// — so an icon field in the registry would be a second copy of a fact the app
// is already serving, kept in sync by hand and wrong the moment someone
// redesigns their favicon. This asks the app instead.
//
// Two ways in, tried in that order, because neither covers every app:
//
//   app-<name>:3000     the container directly. Bypasses traefik, so it works
//                       for a forward-auth'd app whose icon path would
//                       otherwise 302 to Pocket ID, AND for an app with
//                       stage = "off" that has no ingress at all. Reachable
//                       only for apps that joined app-db-net, which is to say
//                       apps with postgres — daedalus is on that bridge.
//   https://<hostname>  through traefik. The fallback for everything else,
//                       and subject to the gate: an app in proxy auth mode
//                       with no bypass for its icon path answers with the
//                       IdP's HTML, which `looksLikeImage` is what rejects.
//
// An app that answers on neither renders a monogram in the UI. That is a real
// state, not a failure. It is also why a forward-auth'd app has to name its
// icon paths in `auth.bypassRule` — Argus reaches here only through traefik,
// since it lives in gluetun's netns and has no container address, so without
// the bypass every path below answers with the IdP's HTML.

import { Buffer } from 'node:buffer'
import { swrCache } from './cache'

export type ResolvedIcon = { body: Buffer; contentType: string }

/**
 * Paths to try when the app's HTML declares nothing.
 *
 * `/icon.svg` leads because it is the TanStack Start convention (`public/
 * icon.svg`) and every app on this box is one. Vector first: these render at
 * 20px in a list row and at 44px on a detail page.
 */
const FALLBACK_PATHS = [
  '/icon.svg',
  '/favicon.svg',
  '/icon.png',
  '/apple-icon.png',
  '/apple-touch-icon.png',
  '/favicon.ico',
]

const CACHE_TTL_MS = 60 * 60 * 1000
const FETCH_TIMEOUT_MS = 4000

const cache = swrCache({ ttlMs: CACHE_TTL_MS })

/**
 * The app's icon, or null when it does not serve a usable one.
 *
 * Cached for an hour and keyed by name. A miss is cached too — a monogram is
 * the right answer for an app in gluetun's netns and re-probing six paths on
 * every list render to re-learn that would cost more than the icons do. The
 * wrapper object is what makes that work with lib/cache.ts, where a bare
 * null means "the load failed, retry soon": here a null icon is an ANSWER,
 * so it rides inside a value the cache keeps for the full hour.
 */
export async function appIcon(
  name: string,
  hostname: string,
  exposed: boolean,
): Promise<ResolvedIcon | null> {
  const { icon } = await cache.get(name, async (): Promise<{ icon: ResolvedIcon | null }> => {
    for (const origin of origins(name, hostname, exposed)) {
      const icon = await fromOrigin(origin)
      if (icon) return { icon }
    }
    return { icon: null }
  })
  return icon
}

/** Drop a cached answer, so a redeployed app's new icon is picked up. */
export function forgetAppIcon(name: string): void {
  cache.forget(name)
}

function origins(name: string, hostname: string, exposed: boolean): string[] {
  const direct = `http://app-${name}:3000`
  return exposed ? [direct, `https://${hostname}`] : [direct]
}

/** Ask one origin: what its HTML declares first, then the conventional paths. */
async function fromOrigin(origin: string): Promise<ResolvedIcon | null> {
  const declared = await declaredPaths(origin)
  // The app's own <link rel="icon"> is authoritative; the fallbacks are
  // guesses. Deduped so a declared /icon.svg is not fetched twice.
  //
  // Probed in PARALLEL and picked in order: the requests are cheap GETs to
  // the box's own containers and the answer is cached for an hour, but a
  // serial walk paid the 4s timeout once per missing path — an app with no
  // icon cost ~30s to give up on, on the page's first render.
  const paths = [...new Set([...declared, ...FALLBACK_PATHS])]
  const results = await Promise.all(paths.map((p) => fetchIcon(origin, p)))
  return results.find((r) => r !== null) ?? null
}

/**
 * The icon paths the app's own HTML declares.
 *
 * Best-effort: an app that renders its head on the client declares nothing
 * here, which is why the conventional paths are tried regardless rather than
 * only when this comes back empty.
 */
async function declaredPaths(origin: string): Promise<string[]> {
  try {
    const res = await fetch(origin, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      redirect: 'manual',
    })
    if (!res.ok) return []
    const html = (await res.text()).slice(0, 60_000)
    const out: string[] = []
    for (const m of html.matchAll(/<link\b[^>]*>/gi)) {
      const tag = m[0]
      if (!/rel\s*=\s*["'][^"']*\bicon\b[^"']*["']/i.test(tag)) continue
      const href = /href\s*=\s*["']([^"']+)["']/i.exec(tag)?.[1]
      // Same-origin paths only. An app pointing at a CDN is not something to
      // follow from the control plane.
      // biome-ignore lint/complexity/useOptionalChain: the explicit !== undefined is what narrows `href` for the push — `href?.startsWith()` would not.
      if (href !== undefined && href.startsWith('/')) out.push(href)
    }
    return out
  } catch {
    return []
  }
}

async function fetchIcon(origin: string, path: string): Promise<ResolvedIcon | null> {
  try {
    const res = await fetch(origin + path, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      // A redirect here is the forward-auth gate sending us to Pocket ID.
      // Following it would return the IdP's login page with a 200.
      redirect: 'manual',
    })
    if (res.status !== 200) return null

    const body = Buffer.from(await res.arrayBuffer())
    const contentType = sniff(body)
    // 100 KB is generous for a favicon and small enough that a mislabelled
    // HTML page or a bundle never lands in the cache.
    if (contentType === null || body.length === 0 || body.length > 100_000) return null
    return { body, contentType }
  } catch {
    return null
  }
}

/**
 * The real type of the bytes, or null when they are not an image.
 *
 * Sniffed rather than trusted: `Content-Type` is what the server claims, and
 * on this box at least one app answers `image/x-icon` with the ASCII text of a
 * data: URI. Serving that back would render as a broken image, which looks
 * like daedalus is failing rather than like the app has no icon.
 */
function sniff(body: Buffer): string | null {
  if (body.length >= 8) {
    if (body.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
      return 'image/png'
    if (body[0] === 0xff && body[1] === 0xd8 && body[2] === 0xff) return 'image/jpeg'
    if (body.subarray(0, 6).toString('ascii').startsWith('GIF8')) return 'image/gif'
    if (
      body.subarray(0, 4).toString('ascii') === 'RIFF' &&
      body.subarray(8, 12).toString('ascii') === 'WEBP'
    )
      return 'image/webp'
    // ICO/CUR: a 2-byte zero reserved field, then type 1 or 2.
    if (
      body[0] === 0x00 &&
      body[1] === 0x00 &&
      (body[2] === 0x01 || body[2] === 0x02) &&
      body[3] === 0x00
    )
      return 'image/x-icon'
  }

  // SVG is text, so it is matched on content rather than magic bytes — and
  // only when the document really opens with a prolog or an <svg> element.
  const head = body.subarray(0, 512).toString('utf8').trimStart()
  if (head.startsWith('<svg') || (head.startsWith('<?xml') && /<svg\b/i.test(head)))
    return 'image/svg+xml'

  return null
}
