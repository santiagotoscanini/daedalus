import { request } from 'node:https'

// What Apple has shipped since the macOS a Mac is running, for the macOS
// tab: the point releases of its own line it has not taken, and the next
// major waiting past them — each with its date, its build, Apple's own
// release notes and its security content.
//
// Three Apple pages answer this box, none of them an API meant for it:
//
// - support.apple.com/100100, the security-releases table: every macOS
//   release Apple has published, by name and version, with its date and a
//   link to its security content. The one list that is complete — the
//   developer RSS keeps three items and the version feed omits names.
// - gdmf.apple.com/v2/pmv, the version feed Software Update itself reads:
//   version → build, plus which boards each build is for. Signed by Apple's
//   private root, which no system store carries; that root is pinned below
//   rather than verification switched off.
// - developer.apple.com's release notes, which are DocC pages with a JSON
//   twin under /tutorials/data/: the notes for 26.6 (a point release shares
//   its minor's page) as headings and bullet lists this box can render.
//
// Read when the tab opens, cached six hours; a page that does not answer
// leaves its field empty with the reason and the rest of the tab stands.

export type MacNoteSection = {
  /** "Finder", "Messages", "General"… */
  area: string
  /** "Resolved Issues", "Known Issues", "New Features", "Deprecations". */
  kind: string
  items: string[]
}

export type MacRelease = {
  /** As Apple prints it: "26.6.2", "26.7", "27". */
  version: string
  /** "Tahoe", "Golden Gate". */
  name: string
  build: string | null
  /** ISO date, from the security table. */
  date: string | null
  securityUrl: string | null
  /** Distinct CVE ids on the security page; null when not read. */
  cves: number | null
  /** Apple's own line when there is nothing to count. */
  securityNote: string | null
  /** The developer release notes for this version's minor. */
  notesUrl: string | null
  notes: MacNoteSection[]
}

export type MacReleases = {
  /** The running version and build, as the agent reported them; the name is Apple's for that major. */
  running: { version: string; build: string | null; name: string | null }
  /** The running line's newer releases, newest first. */
  line: MacRelease[]
  /** The next major's newest release, when one is out. */
  next: MacRelease | null
  checkedAt: string
  source: string
  error: string | null
}

const TTL_MS = 6 * 3600_000
const READ_MS = 12_000
const TABLE_URL = 'https://support.apple.com/en-us/100100'
const PMV_URL = 'https://gdmf.apple.com/v2/pmv'
const UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36'

/**
 * Apple Root CA (expires 2035), from apple.com/certificateauthority. The
 * version feed's chain ends here rather than at a public root.
 */
const APPLE_ROOT_CA = `-----BEGIN CERTIFICATE-----
MIIEuzCCA6OgAwIBAgIBAjANBgkqhkiG9w0BAQUFADBiMQswCQYDVQQGEwJVUzET
MBEGA1UEChMKQXBwbGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlv
biBBdXRob3JpdHkxFjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwHhcNMDYwNDI1MjE0
MDM2WhcNMzUwMjA5MjE0MDM2WjBiMQswCQYDVQQGEwJVUzETMBEGA1UEChMKQXBw
bGUgSW5jLjEmMCQGA1UECxMdQXBwbGUgQ2VydGlmaWNhdGlvbiBBdXRob3JpdHkx
FjAUBgNVBAMTDUFwcGxlIFJvb3QgQ0EwggEiMA0GCSqGSIb3DQEBAQUAA4IBDwAw
ggEKAoIBAQDkkakJH5HbHkdQ6wXtXnmELes2oldMVeyLGYne+Uts9QerIjAC6Bg+
+FAJ039BqJj50cpmnCRrEdCju+QbKsMflZ56DKRHi1vUFjczy8QPTc4UadHJGXL1
XQ7Vf1+b8iUDulWPTV0N8WQ1IxVLFVkds5T39pyez1C6wVhQZ48ItCD3y6wsIG9w
tj8BMIy3Q88PnT3zK0koGsj+zrW5DtleHNbLPbU6rfQPDgCSC7EhFi501TwN22IW
q6NxkkdTVcGvL0Gz+PvjcM3mo0xFfh9Ma1CWQYnEdGILEINBhzOKgbEwWOxaBDKM
aLOPHd5lc/9nXmW8Sdh2nzMUZaF3lMktAgMBAAGjggF6MIIBdjAOBgNVHQ8BAf8E
BAMCAQYwDwYDVR0TAQH/BAUwAwEB/zAdBgNVHQ4EFgQUK9BpR5R2Cf70a40uQKb3
R01/CF4wHwYDVR0jBBgwFoAUK9BpR5R2Cf70a40uQKb3R01/CF4wggERBgNVHSAE
ggEIMIIBBDCCAQAGCSqGSIb3Y2QFATCB8jAqBggrBgEFBQcCARYeaHR0cHM6Ly93
d3cuYXBwbGUuY29tL2FwcGxlY2EvMIHDBggrBgEFBQcCAjCBthqBs1JlbGlhbmNl
IG9uIHRoaXMgY2VydGlmaWNhdGUgYnkgYW55IHBhcnR5IGFzc3VtZXMgYWNjZXB0
YW5jZSBvZiB0aGUgdGhlbiBhcHBsaWNhYmxlIHN0YW5kYXJkIHRlcm1zIGFuZCBj
b25kaXRpb25zIG9mIHVzZSwgY2VydGlmaWNhdGUgcG9saWN5IGFuZCBjZXJ0aWZp
Y2F0aW9uIHByYWN0aWNlIHN0YXRlbWVudHMuMA0GCSqGSIb3DQEBBQUAA4IBAQBc
NplMLXi37Yyb3PN3m/J20ncwT8EfhYOFG5k9RzfyqZtAjizUsZAS2L70c5vu0mQP
y3lPNNiiPvl4/2vIB+x9OYOLUyDTOMSxv5pPCmv/K/xZpwUJfBdAVhEedNO3iyM7
R6PVbyTi69G3cN8PReEnyvFteO3ntRcXqNx+IjXKJdXZD9Zr1KIkIxH3oayPc4Fg
xhtbCS+SsvhESPBgOJ4V9T0mZyCKM2r3DYLP3uujL/lTaltkwGMzd/c6ByxW69oP
IQ7aunMZT7XZNn/Bh1XZp5m5MkL72NVxnn6hUrcbvZNCJBIqxw8dtk2cXmPIS4AX
UKqK1drk/NAJBzewdXUh
-----END CERTIFICATE-----`

type Cached<T> = { at: number; value: T }
const tableCache: { v: Cached<TableRow[]> | null } = { v: null }
const pmvCache: { v: Cached<Map<string, PmvBuild[]>> | null } = { v: null }
const notesCache = new Map<string, Cached<{ url: string | null; sections: MacNoteSection[] }>>()
const securityCache = new Map<string, Cached<{ cves: number | null; note: string | null }>>()

function fresh<T>(c: Cached<T> | null | undefined): T | null {
  return c !== null && c !== undefined && Date.now() - c.at < TTL_MS ? c.value : null
}

/* ── the security table ───────────────────────────────────────────────── */

export type TableRow = {
  /** "Tahoe" / "Golden Gate". */
  name: string
  version: string
  date: string | null
  url: string | null
  /** Text Apple put in the name cell beside the link, when any. */
  note: string | null
}

const MONTHS: Record<string, string> = {
  jan: '01',
  feb: '02',
  mar: '03',
  apr: '04',
  may: '05',
  jun: '06',
  jul: '07',
  aug: '08',
  sep: '09',
  sept: '09',
  oct: '10',
  nov: '11',
  dec: '12',
}

/** "17 Aug 2026" → "2026-08-17". */
export function tableDate(s: string): string | null {
  const m = s.trim().match(/^(\d{1,2}) ([A-Za-z]+) (\d{4})$/)
  if (m === null) return null
  const mon = MONTHS[(m[2] ?? '').toLowerCase()]
  return mon === undefined ? null : `${m[3] ?? ''}-${mon}-${(m[1] ?? '').padStart(2, '0')}`
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&#39;|&rsquo;/g, '’')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * The macOS rows of Apple's table. Each row is three cells — a name that
 * is usually a link, what it is for, and a date — and only the rows whose
 * name reads "macOS <Name> <version>" are kept: Safari, Xcode and the
 * Rapid Security Responses share the table.
 */
export function parseSecurityTable(html: string): TableRow[] {
  const out: TableRow[] = []
  const rows = html.replace(/\n/g, ' ').match(/<tr[\s>][\s\S]*?<\/tr>/g) ?? []
  for (const row of rows) {
    const cells = row.match(/<td[\s>][\s\S]*?<\/td>/g) ?? []
    const head = cells[0]
    const dateCell = cells[2]
    if (head === undefined || dateCell === undefined) continue
    const link = head.match(/<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/)
    const title = stripTags(link?.[2] ?? head)
    const m = title.match(/^macOS ([A-Z][A-Za-z ]+?) (\d+(?:\.\d+)*)$/)
    const name = m?.[1]
    const version = m?.[2]
    if (name === undefined || version === undefined) continue
    const rest = stripTags(head.replace(link?.[0] ?? '', ''))
    out.push({
      name: name.trim(),
      version,
      date: tableDate(stripTags(dateCell)),
      url: link?.[1] ?? null,
      note: rest === '' ? null : rest,
    })
  }
  return out
}

async function fetchText(url: string, headers: Record<string, string> = {}): Promise<string> {
  const res = await fetch(url, {
    signal: AbortSignal.timeout(READ_MS),
    redirect: 'follow',
    headers: { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', ...headers },
  })
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
  return res.text()
}

async function securityTable(): Promise<TableRow[]> {
  const hit = fresh(tableCache.v)
  if (hit !== null) return hit
  const rows = parseSecurityTable(await fetchText(TABLE_URL))
  if (rows.length === 0) throw new Error('the security table had no macOS rows')
  tableCache.v = { at: Date.now(), value: rows }
  return rows
}

/* ── the version feed ─────────────────────────────────────────────────── */

type PmvBuild = { build: string; posted: string | null; devices: string[] }

/** One GET over a chain that ends at Apple's own root. */
function getPinned(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = request(
      url,
      { ca: [APPLE_ROOT_CA], headers: { 'user-agent': UA }, timeout: READ_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume()
          reject(new Error(`HTTP ${String(res.statusCode)}`))
          return
        }
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')))
        res.on('error', reject)
      },
    )
    req.on('timeout', () => req.destroy(new Error('timeout')))
    req.on('error', reject)
    req.end()
  })
}

/** Version → its builds, from the feed. */
export function parsePmv(text: string): Map<string, PmvBuild[]> {
  const body = JSON.parse(text) as {
    PublicAssetSets?: {
      macOS?: {
        ProductVersion?: string
        Build?: string
        PostingDate?: string
        SupportedDevices?: string[]
      }[]
    }
  }
  const out = new Map<string, PmvBuild[]>()
  for (const a of body.PublicAssetSets?.macOS ?? []) {
    if (typeof a.ProductVersion !== 'string' || typeof a.Build !== 'string') continue
    const list = out.get(a.ProductVersion) ?? []
    if (!list.some((b) => b.build === a.Build)) {
      list.push({
        build: a.Build,
        posted: a.PostingDate ?? null,
        devices: a.SupportedDevices ?? [],
      })
    }
    out.set(a.ProductVersion, list)
  }
  return out
}

async function versionFeed(): Promise<Map<string, PmvBuild[]>> {
  const hit = fresh(pmvCache.v)
  if (hit !== null) return hit
  const v = parsePmv(await getPinned(PMV_URL))
  pmvCache.v = { at: Date.now(), value: v }
  return v
}

/**
 * The build a version means for this Mac: the one listing its board when
 * the agent named it, else the general one — a major ships a second build
 * for the hardware announced with it, numbered higher (26A5428 beside
 * 26A428), so the lowest number is the one every existing Mac gets.
 */
export function buildFor(builds: PmvBuild[] | undefined, target: string | null): string | null {
  if (builds === undefined || builds.length === 0) return null
  if (target !== null) {
    const mine = builds.find((b) => b.devices.includes(target))
    if (mine !== undefined) return mine.build
  }
  const n = (b: string) => Number.parseInt(b.replace(/^\d+[A-Z]/, ''), 10) || 0
  return [...builds].sort((a, b) => n(a.build) - n(b.build))[0]?.build ?? null
}

/* ── release notes ────────────────────────────────────────────────────── */

type Inline = {
  type: string
  text?: string
  code?: string
  identifier?: string
  inlineContent?: Inline[]
}

type DocBlock = {
  type: string
  level?: number
  text?: string
  items?: { content?: DocBlock[] }[]
  inlineContent?: Inline[]
}

/** DocC's link targets, keyed by identifier, each with the title the page shows. */
type Refs = Record<string, { title?: string } | undefined>

function inlineText(blocks: Inline[] | undefined, refs: Refs): string {
  return (blocks ?? [])
    .map((b) =>
      b.type === 'text'
        ? (b.text ?? '')
        : b.type === 'codeVoice'
          ? (b.code ?? '')
          : b.type === 'reference'
            ? (refs[b.identifier ?? '']?.title ?? b.identifier?.split('/').pop() ?? '')
            : b.inlineContent !== undefined
              ? inlineText(b.inlineContent, refs)
              : (b.text ?? ''),
    )
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
}

/**
 * DocC's content list, folded into sections: a level-3 heading names an
 * area, a level-4 heading under it says what kind of list follows, and the
 * bullet list under that is the notes. Apple's radar numbers at the end of
 * each item are dropped.
 */
export function parseReleaseNotes(text: string): MacNoteSection[] {
  const body = JSON.parse(text) as {
    primaryContentSections?: { kind?: string; content?: DocBlock[] }[]
    references?: Refs
  }
  const refs = body.references ?? {}
  const content = body.primaryContentSections?.find((s) => s.kind === 'content')?.content ?? []
  const out: MacNoteSection[] = []
  let area = 'General'
  let kind = 'Notes'
  for (const b of content) {
    if (b.type === 'heading') {
      const t = (b.text ?? '').trim()
      if (b.level === 3) {
        area = t
        kind = 'Notes'
      } else if (b.level === 4) kind = t
      continue
    }
    if (b.type !== 'unorderedList') continue
    const items = (b.items ?? [])
      .map((it) =>
        (it.content ?? [])
          .map((p) => inlineText(p.inlineContent, refs))
          .join(' ')
          // "(174841181) (FB22512943)": Apple's radar and Feedback ids.
          .replace(/(\s*\((?:FB)?\d{6,}\))+\s*$/, '')
          .trim(),
      )
      .filter((s) => s !== '')
    if (items.length === 0) continue
    const existing = out.find((s) => s.area === area && s.kind === kind)
    if (existing !== undefined) existing.items.push(...items)
    else out.push({ area, kind, items })
  }
  return out
}

/** "26.6.2" → ["macos-26_6-release-notes", "macos-26-release-notes"]. */
export function notesSlugs(version: string): string[] {
  const [major = version, minor] = version.split('.')
  const out: string[] = []
  if (minor !== undefined && minor !== '0') out.push(`macos-${major}_${minor}-release-notes`)
  if (minor !== undefined && minor === '0') out.push(`macos-${major}_0-release-notes`)
  out.push(`macos-${major}-release-notes`)
  return out
}

async function releaseNotes(
  version: string,
): Promise<{ url: string | null; sections: MacNoteSection[] }> {
  const key = notesSlugs(version)[0] ?? version
  const hit = fresh(notesCache.get(key))
  if (hit !== null) return hit
  for (const slug of notesSlugs(version)) {
    try {
      const text = await fetchText(
        `https://developer.apple.com/tutorials/data/documentation/macos-release-notes/${slug}.json`,
      )
      const v = {
        url: `https://developer.apple.com/documentation/macos-release-notes/${slug}`,
        sections: parseReleaseNotes(text),
      }
      notesCache.set(key, { at: Date.now(), value: v })
      return v
    } catch {
      // the next slug: a major's notes live under its bare number
    }
  }
  return { url: null, sections: [] }
}

/** How many CVEs the security page names, or Apple's line that it names none. */
export function parseSecurityPage(html: string): { cves: number | null; note: string | null } {
  const text = stripTags(html)
  const ids = new Set(text.match(/CVE-\d{4}-\d{4,}/g) ?? [])
  if (ids.size > 0) return { cves: ids.size, note: null }
  const none = text.match(/This update has no published CVE entries\.?/)
  return { cves: none === null ? null : 0, note: none === null ? null : none[0] }
}

async function securityContent(url: string): Promise<{ cves: number | null; note: string | null }> {
  const hit = fresh(securityCache.get(url))
  if (hit !== null) return hit
  const v = parseSecurityPage(await fetchText(url))
  securityCache.set(url, { at: Date.now(), value: v })
  return v
}

/* ── the answer ───────────────────────────────────────────────────────── */

export function versionParts(v: string): number[] {
  return v.split('.').map((x) => Number.parseInt(x, 10) || 0)
}

/** Positive when a is newer than b. */
export function compareVersions(a: string, b: string): number {
  const x = versionParts(a)
  const y = versionParts(b)
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * The running version as the agent reports it — "26.6.1 (25G76)" on the
 * status page, or the bare version — split into version and build.
 */
export function splitRunning(osVersion: string): { version: string; build: string | null } {
  const m = osVersion.match(/^(\d+(?:\.\d+)*)\s*(?:\(([^)]+)\))?/)
  return m === null
    ? { version: osVersion, build: null }
    : { version: m[1] ?? osVersion, build: m[2] ?? null }
}

export async function macosReleases(
  osVersion: string,
  target: string | null,
): Promise<MacReleases> {
  const checkedAt = new Date().toISOString()
  const base: MacReleases = {
    running: { ...splitRunning(osVersion), name: null },
    line: [],
    next: null,
    checkedAt,
    source: TABLE_URL,
    error: null,
  }
  let rows: TableRow[]
  try {
    rows = await securityTable()
  } catch (e) {
    return { ...base, error: `Apple’s release table did not answer: ${errorText(e)}` }
  }
  // The feed is worth having but not worth losing the list over.
  const feed = await versionFeed().catch(() => null)
  const major = versionParts(base.running.version)[0] ?? 0
  const running = {
    ...base.running,
    name: rows.find((r) => versionParts(r.version)[0] === major)?.name ?? null,
  }
  const newer = rows.filter((r) => compareVersions(r.version, running.version) > 0)
  const line = newer
    .filter((r) => versionParts(r.version)[0] === major)
    .sort((a, b) => compareVersions(b.version, a.version))
  const nextRows = newer
    .filter((r) => versionParts(r.version)[0] === major + 1)
    .sort((a, b) => compareVersions(b.version, a.version))
  const next = nextRows[0] ?? null

  const enrich = async (r: TableRow): Promise<MacRelease> => {
    const feedVersion = r.version.includes('.') ? r.version : `${r.version}.0`
    const [notes, sec] = await Promise.all([
      releaseNotes(feedVersion),
      r.url === null ? Promise.resolve({ cves: null, note: null }) : securityContent(r.url),
    ])
    return {
      version: r.version,
      name: r.name,
      build: buildFor(feed?.get(feedVersion) ?? feed?.get(r.version), target),
      date: r.date,
      securityUrl: r.url,
      cves: sec.cves,
      securityNote: sec.note ?? r.note,
      notesUrl: notes.url,
      notes: notes.sections,
    }
  }
  const [lineOut, nextOut] = await Promise.all([
    Promise.all(line.slice(0, 6).map(enrich)),
    next === null ? Promise.resolve(null) : enrich(next),
  ])
  return { ...base, running, line: lineOut, next: nextOut }
}

function errorText(e: unknown): string {
  return e instanceof Error ? e.message : String(e)
}
