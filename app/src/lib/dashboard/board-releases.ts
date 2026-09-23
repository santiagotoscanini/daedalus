import { inflateRawSync } from 'node:zlib'

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
// Gigabyte's host is reachable too but its file names are not derivable
// from the board's name (they carry a revision suffix the site assigns),
// and Apple ships firmware inside macOS, so neither has a list here yet;
// each says so on the tab. A vendor that is not recognised gets nothing and
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
  error: string | null
}

const NONE: BoardReleases = {
  make: null,
  source: null,
  releases: [],
  running: null,
  behind: null,
  checkedAt: null,
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
  if (make === 'gigabyte') {
    return {
      ...NONE,
      make,
      error:
        'gigabyte.com refuses this address, and its download host names packages in a way the board’s name does not give away; no list yet.',
    }
  }
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
    error,
  }
}
