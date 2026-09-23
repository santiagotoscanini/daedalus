import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { inflateRawSync } from 'node:zlib'

import { writeAtomic } from '../../host/bridge'
import { env } from '../../host/env'
import { gigabytePageSlug, gigabytePageUrl } from '../hardware/gigabyte'

import { pool } from '../http'

// The BIOS releases a board's maker has published, so the Motherboard tab
// can say "eight behind" and what each one changed — read from the maker's
// DOWNLOAD host, not its website.
//
// The website is the obvious source and the wrong one: msi.com and
// gigabyte.com sit behind Akamai's bot manager, which answers 403 to this
// box's address whether the caller is curl or a real Chromium, and to
// Anthropic's fetcher too. The download hosts are plain CDNs. MSI's names
// every package by board code and version (`7E02v1H.zip`), answers a HEAD
// for each with the package's date, 404s cleanly past the newest, and the
// first entry in every package is a one-page release note in English. So
// the list is enumerated, the date is the package's, and the note is read
// out of the first sixteen kilobytes of each package with a Range request —
// the firmware image behind it is ten megabytes nobody here needs.
//
// Gigabyte refuses every plain client and names its packages with an
// opaque token, so its list comes from the box's own browser (below);
// Apple ships firmware inside macOS, so the Mac has no list here and
// says so. A vendor that is not recognised gets nothing and
// no error — the tab shows what SMBIOS knows and stops.
//
// Cached in this process: the list for twelve hours, a version's note
// forever (a published note does not change). A failure keeps the last
// good list and says when it was last read.

export type BoardRelease = {
  /** As the maker names it: "1.H0" (MSI, matching SMBIOS), "F42c" (Gigabyte). */
  version: string
  /** ISO date, from the package. */
  date: string | null
  /** The English changelog lines, as published; empty when the note was unreadable. */
  notes: string[]
  url: string | null
  sizeBytes: number | null
}

export type BoardReleases = {
  make: 'msi' | 'gigabyte' | 'apple' | null
  /** Where the list came from, for the foot. */
  source: string | null
  /** Newest first. */
  releases: BoardRelease[]
  /** The running version, spelled the way the list spells it — or null when unmatched. */
  running: string | null
  /** How many releases are newer than the running one; null when unmatched. */
  behind: number | null
  checkedAt: string | null
  /** Something the reader worked out that the numbers alone would not say. */
  note: string | null
  error: string | null
}

const NONE: BoardReleases = {
  make: null,
  source: null,
  releases: [],
  running: null,
  behind: null,
  checkedAt: null,
  note: null,
  error: null,
}

const LIST_TTL_MS = 12 * 3600_000
const HEAD_MS = 8_000
const NOTE_MS = 15_000

/** What SMBIOS says about the board, as the two hosts report it. */
export type BoardIdentity = {
  vendor: string | null
  product: string | null
  biosVersion: string | null
  /** As SMBIOS states it: "12/21/2023" on Windows, "03/24/2024" on the box, ISO on a Mac. */
  biosDate?: string | null
}

export function boardMake(vendor: string | null): BoardReleases['make'] {
  if (vendor === null) return null
  if (/micro-star/i.test(vendor)) return 'msi'
  if (/gigabyte/i.test(vendor)) return 'gigabyte'
  if (/^apple/i.test(vendor)) return 'apple'
  return null
}

/** "PRO B760M-P DDR4 (MS-7E02)" → "7E02". */
export function msiCode(product: string | null): string | null {
  const m = product?.match(/\(MS-([0-9A-Z]{4})\)/i)
  return m?.[1]?.toUpperCase() ?? null
}

/**
 * MSI's SMBIOS version and its package name are one string spelled twice:
 * "1.H0" on the board is `v1H` on the host — the dot dropped, the trailing
 * zero dropped. Both sides are normalised to the two characters that vary.
 */
export function msiKey(version: string): string | null {
  const m = version.trim().match(/^(\d)\.([0-9A-Z])0?$/i)
  return m?.[1] === undefined || m[2] === undefined ? null : `${m[1]}${m[2].toUpperCase()}`
}

/** `v1H` → "1.H0", the way SMBIOS and MSI's note spell it. */
export function msiVersion(key: string): string {
  return `${key[0]}.${key[1]}0`
}

/**
 * The order MSI counts in: the minor digit runs 0–9 then A–Z. Enumeration
 * walks it in batches and stops at the first empty batch past a hit.
 */
const MINOR = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ'

function* msiKeys(): Generator<string> {
  for (const major of ['1', '2', '3']) {
    for (const minor of MINOR) yield `${major}${minor}`
  }
}

// ── the note inside the package ──────────────────────────────────────────

/**
 * The first text entry of a zip, from its first bytes.
 *
 * A zip's local file headers sit at the front, each followed by its data,
 * and MSI's packages put the note first (after the directory entry), so
 * the head of the file holds the whole note. Walks the headers until it
 * finds a `.txt`, inflates it (or reads it stored), and gives up quietly on
 * anything else: a truncated header, a streamed entry with no sizes, an
 * unknown method.
 */
export function zipTextEntry(head: Buffer): string | null {
  let at = 0
  for (let n = 0; n < 8; n++) {
    if (at + 30 > head.length || head.readUInt32LE(at) !== 0x04034b50) return null
    const method = head.readUInt16LE(at + 8)
    const compressed = head.readUInt32LE(at + 18)
    const nameLen = head.readUInt16LE(at + 26)
    const extraLen = head.readUInt16LE(at + 28)
    const name = head.subarray(at + 30, at + 30 + nameLen).toString('utf8')
    const data = at + 30 + nameLen + extraLen
    if (/\.txt$/i.test(name)) {
      if (data + compressed > head.length) return null
      const raw = head.subarray(data, data + compressed)
      try {
        const out = method === 8 ? inflateRawSync(raw) : method === 0 ? raw : null
        if (out === null) return null
        const s = out.toString('utf8')
        // A byte-order mark, which MSI's notes open with and a regex would hide.
        return s.charCodeAt(0) === 0xfeff ? s.slice(1) : s
      } catch {
        return null
      }
    }
    at = data + compressed
  }
  return null
}

/**
 * MSI's note, English section only: the lines under "This BIOS fixes the
 * following problem", plus the firmware lines beside them, until the date
 * line or the Chinese sections. The date on the "3." line is the note's own
 * and outranks the package's mtime, which is when the file was uploaded.
 */
export function parseMsiNote(text: string): { notes: string[]; date: string | null } {
  const lines = text.split(/\r?\n/).map((l) => l.trim())
  const notes: string[] = []
  let date: string | null = null
  let inFixes = false
  for (const line of lines) {
    if (/^\[Below information/i.test(line)) break
    const d = line.match(/^3\.\s*(\d{4})\/(\d{1,2})\/(\d{1,2})/)
    if (d) {
      date = `${d[1] ?? ''}-${(d[2] ?? '').padStart(2, '0')}-${(d[3] ?? '').padStart(2, '0')}`
      inFixes = false
      continue
    }
    if (/^2\./.test(line)) {
      inFixes = true
      const rest = line.replace(/^2\.\s*/, '')
      if (rest && !/fixes the following problem/i.test(rest)) notes.push(rest)
      continue
    }
    if (!inFixes || line === '') continue
    const item = line.replace(/^[-–•*]\s*/, '').replace(/\s*\(download\)\s*$/i, '')
    if (/^ME Firmware update SOP$/i.test(item)) continue
    if (item) notes.push(item)
  }
  return { notes, date }
}

// ── the MSI list ─────────────────────────────────────────────────────────

const noteCache = new Map<string, { notes: string[]; date: string | null }>()
const listCache = new Map<string, { at: number; releases: BoardRelease[]; error: string | null }>()

async function msiHead(code: string, key: string): Promise<BoardRelease | null> {
  const url = `https://download.msi.com/bos_exe/mb/${code}v${key}.zip`
  const res = await fetch(url, { method: 'HEAD', signal: AbortSignal.timeout(HEAD_MS) })
  if (res.status === 404) return null
  if (!res.ok) throw new Error(`HTTP ${String(res.status)} for ${code}v${key}`)
  const mtime = res.headers.get('last-modified')
  const size = res.headers.get('content-length')
  return {
    version: msiVersion(key),
    date: mtime === null || Number.isNaN(Date.parse(mtime)) ? null : dateOnly(mtime),
    notes: [],
    url,
    sizeBytes: size === null ? null : Number(size),
  }
}

async function msiNote(url: string): Promise<{ notes: string[]; date: string | null }> {
  const hit = noteCache.get(url)
  if (hit !== undefined) return hit
  const res = await fetch(url, {
    headers: { range: 'bytes=0-16383' },
    signal: AbortSignal.timeout(NOTE_MS),
  })
  if (!res.ok) throw new Error(`HTTP ${String(res.status)}`)
  const head = Buffer.from(await res.arrayBuffer())
  const text = zipTextEntry(head)
  const parsed = text === null ? { notes: [], date: null } : parseMsiNote(text)
  // A package whose note could not be read is not retried every twelve
  // hours: the package is immutable, so neither is the failure.
  noteCache.set(url, parsed)
  return parsed
}

async function msiList(code: string): Promise<{ releases: BoardRelease[]; error: string | null }> {
  // Six HEADs at a time, in MSI's order, until a whole batch past the last
  // hit comes back empty: a cold read is two dozen requests in four rounds
  // rather than one at a time, and a skipped letter (a version pulled
  // before release) does not end the walk early.
  const releases: BoardRelease[] = []
  const keys = [...msiKeys()]
  for (let i = 0; i < keys.length; i += 6) {
    const batch = keys.slice(i, i + 6)
    const found = await pool(
      batch.map((key) => () => msiHead(code, key)),
      6,
    )
    const hits = found.filter((r): r is BoardRelease => r !== null)
    releases.push(...hits)
    if (hits.length === 0 && releases.length > 0) break
    // Two whole majors with nothing is a code that names no package.
    if (hits.length === 0 && i >= 2 * MINOR.length - 6) break
  }
  const failures: string[] = []
  await pool(
    releases.map((r) => async () => {
      if (r.url === null) return
      try {
        const n = await msiNote(r.url)
        r.notes = n.notes
        if (n.date !== null) r.date = n.date
      } catch (e) {
        failures.push(`${r.version}: ${e instanceof Error ? e.message : String(e)}`)
      }
    }),
    4,
  )
  releases.reverse()
  return {
    releases,
    error: failures.length === 0 ? null : `notes unread for ${failures.join(', ')}`,
  }
}

function dateOnly(httpDate: string): string {
  return new Date(httpDate).toISOString().slice(0, 10)
}

// ── the Gigabyte list, from the box's browser ────────────────────────────
//
// gigabyte.com refuses every plain HTTP client, and its packages carry an
// opaque per-board token in their names, so neither the site nor the
// download host can be read from here. A real browser gets in — the box's
// shotter Chromium with a browser's fingerprint does — so the list is read
// by a box-side job (the host's stacks/shotter) and published under the
// apply dir, the way the system snapshot is: this reader writes the pages
// it wants to `boards/request.json`, the job reads each page and writes
// `boards/<id>.json`, and this reader draws it. A host without that job
// leaves the request unanswered, and the tab says so.

export type BoardPageRequest = { version: 1; pages: { id: string; url: string }[] }

export type BoardPageSnapshot = {
  version: 1
  fetchedAt: string
  url: string
  rows: {
    version: string
    date: string | null
    sizeBytes: number | null
    notes: string[]
    url: string | null
  }[]
  error: string | null
}

const applyDir = (): string => env.get('APPLY_DIR') ?? '/apply'
const boardsDir = (): string => join(applyDir(), 'boards')

async function readPageSnapshot(id: string): Promise<BoardPageSnapshot | null> {
  try {
    const raw = await readFile(join(boardsDir(), `${id}.json`), 'utf8')
    const doc = JSON.parse(raw) as Partial<BoardPageSnapshot>
    if (doc.version !== 1 || !Array.isArray(doc.rows)) return null
    return {
      version: 1,
      fetchedAt: typeof doc.fetchedAt === 'string' ? doc.fetchedAt : '',
      url: typeof doc.url === 'string' ? doc.url : '',
      rows: doc.rows
        .filter((r): r is BoardPageSnapshot['rows'][number] => typeof r?.version === 'string')
        .map((r) => ({
          version: r.version,
          date: typeof r.date === 'string' ? r.date : null,
          sizeBytes: typeof r.sizeBytes === 'number' ? r.sizeBytes : null,
          notes: Array.isArray(r.notes) ? r.notes.filter((n) => typeof n === 'string') : [],
          url: typeof r.url === 'string' ? r.url : null,
        })),
      error: typeof doc.error === 'string' ? doc.error : null,
    }
  } catch {
    return null
  }
}

/** Ask the box's job for a page, once: the request is rewritten only when it changes. */
async function requestPage(id: string, url: string): Promise<void> {
  const path = join(boardsDir(), 'request.json')
  let current: BoardPageRequest = { version: 1, pages: [] }
  try {
    const doc = JSON.parse(await readFile(path, 'utf8')) as Partial<BoardPageRequest>
    if (doc.version === 1 && Array.isArray(doc.pages)) current = { version: 1, pages: doc.pages }
  } catch {
    // No request yet.
  }
  if (current.pages.some((p) => p.id === id && p.url === url)) return
  const pages = [...current.pages.filter((p) => p.id !== id), { id, url }]
  await mkdir(boardsDir(), { recursive: true })
  await writeAtomic(path, `${JSON.stringify({ version: 1, pages }, null, 2)}\n`)
}

async function gigabyteReleases(id: BoardIdentity): Promise<BoardReleases> {
  const product = id.product?.trim() ?? ''
  const make = 'gigabyte' as const
  if (product === '') return { ...NONE, make, error: 'no board name to look up' }
  const url = gigabytePageUrl(product, id.biosVersion)
  const pageId = `gigabyte-${gigabytePageSlug(product, id.biosVersion).toLowerCase()}`
  const snap = await readPageSnapshot(pageId)
  if (snap === null) {
    await requestPage(pageId, url)
    return {
      ...NONE,
      make,
      source: url,
      error:
        'gigabyte.com refuses every plain client, so the box’s browser reads the page for it; that job has not answered yet (it runs when a page is asked for, and daily).',
    }
  }
  const releases: BoardRelease[] = snap.rows.map((r) => ({
    version: r.version,
    date: r.date,
    notes: r.notes,
    url: r.url,
    sizeBytes: r.sizeBytes,
  }))
  // Gigabyte pulls a release from its page now and then (FA2a is gone while
  // FA2 and FA4 stay), so a running version that is not listed is counted
  // against its build date instead: every listed release newer than the
  // firmware's own date is one it is behind.
  const listed =
    id.biosVersion === null
      ? null
      : (releases.find((r) => r.version.toLowerCase() === id.biosVersion?.toLowerCase())?.version ??
        null)
  const built = smbiosDate(id.biosDate ?? null)
  let behind: number | null = null
  let note: string | null = null
  if (listed !== null) {
    behind = releases.findIndex((r) => r.version === listed)
  } else if (id.biosVersion !== null && built !== null) {
    behind = releases.filter((r) => r.date !== null && r.date > built).length
    note = `${id.biosVersion} is no longer on Gigabyte’s page; counted against its build date, ${built}.`
  }
  return {
    make,
    source: url,
    releases,
    running: listed ?? id.biosVersion,
    behind,
    checkedAt: snap.fetchedAt === '' ? null : snap.fetchedAt,
    note,
    error: snap.error,
  }
}

/** "12/21/2023" (SMBIOS, US order) or an ISO date → "2023-12-21". */
export function smbiosDate(s: string | null): string | null {
  if (s === null) return null
  const us = /^(\d{1,2})\/(\d{1,2})\/(\d{4})$/.exec(s.trim())
  if (us) return `${us[3]}-${us[1]?.padStart(2, '0') ?? ''}-${us[2]?.padStart(2, '0') ?? ''}`
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(s.trim())
  return iso?.[1] ?? null
}
// ── the public reader ────────────────────────────────────────────────────

export async function boardReleases(id: BoardIdentity): Promise<BoardReleases> {
  const make = boardMake(id.vendor)
  if (make === null) return NONE
  if (make === 'apple') {
    return {
      ...NONE,
      make,
      error:
        'Apple ships this firmware inside macOS; the machine’s own Software Update is the list, on Updates.',
    }
  }
  if (make === 'gigabyte') return gigabyteReleases(id)
  const code = msiCode(id.product)
  if (code === null) {
    return { ...NONE, make, error: 'no MS-xxxx code in the board’s name' }
  }
  const source = `https://download.msi.com/bos_exe/mb/${code}v*.zip`
  const cached = listCache.get(code)
  let releases: BoardRelease[]
  let error: string | null
  let checkedAt: string | null
  if (cached !== undefined && Date.now() - cached.at < LIST_TTL_MS) {
    ;({ releases, error } = cached)
    checkedAt = new Date(cached.at).toISOString()
  } else {
    try {
      const fresh = await msiList(code)
      listCache.set(code, { at: Date.now(), ...fresh })
      ;({ releases, error } = fresh)
      checkedAt = new Date().toISOString()
    } catch (e) {
      const why = e instanceof Error ? e.message : String(e)
      if (cached === undefined) {
        return { ...NONE, make, source, error: `download.msi.com did not answer: ${why}` }
      }
      releases = cached.releases
      checkedAt = new Date(cached.at).toISOString()
      error = `download.msi.com did not answer (${why}); this is the list as of the last read`
    }
  }
  const runningKey = id.biosVersion === null ? null : msiKey(id.biosVersion)
  const running = runningKey === null ? null : msiVersion(runningKey)
  const at = running === null ? -1 : releases.findIndex((r) => r.version === running)
  return {
    make,
    source,
    releases,
    running,
    behind: at < 0 ? null : at,
    checkedAt,
    note: null,
    error,
  }
}
