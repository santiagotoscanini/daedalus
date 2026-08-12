import { readFile, stat } from 'node:fs/promises'
import { DecodeError, type Decoder, decode, num, obj, optional, str } from './decode'

// The one reader for every file the host publishes to this container.
//
// Before this module, each snapshot mount had its own read site doing
// `JSON.parse(raw) as T` — eighteen casts, no staleness signal on most, and a
// malformed file rendering as its typed fallback with nothing saying so. This
// replaces the casts with real decoding and makes the three failure modes
// distinct, because they mean different things on a dashboard:
//
//   missing   the producer has never run (available: false, no error)
//   malformed the producer is broken — surfaced, not swallowed (error set)
//   stale     the producer stopped — the file says something, but its age
//             exceeds what its timer promises (stale: true)
//
// "A stale file shows yesterday's temperatures as though they were now —
// which is worse than an empty panel, because it looks like an answer."
// (stacks/daedalus/daedalus.nix, on the system snapshot.)
//
// Files come in two framings. The v2 envelope (daedalusExport: 1) carries
// domain, schemaVersion, source and generatedAt around a `data` key — nix
// exports and host snapshots share it. Legacy files are bare documents;
// detected by the absent marker, decoded whole, aged by mtime. Legacy support
// exists so this layer could ship before any producer changed, and each
// fallback dies when its producer adopts the envelope.

export type SnapshotResult<T> = {
  data: T
  /** File existed and decoded. False = data is the caller's fallback. */
  available: boolean
  /** From the envelope, or mtime for legacy files. Null when unavailable. */
  generatedAt: string | null
  ageMs: number | null
  /** Age exceeded maxAgeMs — the producing timer has stopped keeping its promise. */
  stale: boolean
  /** Decode/version failure, one line, path included. Null when clean. */
  error: string | null
}

const envelope = obj({
  daedalusExport: num,
  domain: str,
  schemaVersion: num,
  source: str,
  generatedAt: optional(str, ''),
})

/** Throttled server-side log: a broken producer says so once a minute, not per render. */
const lastLogged = new Map<string, number>()
function logOnce(path: string, message: string): void {
  const now = Date.now()
  if (now - (lastLogged.get(path) ?? 0) < 60_000) return
  lastLogged.set(path, now)
  console.error(`[snapshot] ${path}: ${message}`)
}

export async function readSnapshot<T>(opts: {
  path: string
  /** Decodes the envelope's `data` (or, for legacy files, the whole document). */
  decoder: Decoder<T>
  fallback: T
  /** Envelope schemaVersions this reader understands. Unset = any. */
  acceptVersions?: number[]
  /**
   * When the file counts as stale. Convention: 3× the producing timer's
   * interval, so one missed run is jitter and three is a stopped producer.
   */
  maxAgeMs?: number
}): Promise<SnapshotResult<T>> {
  let raw: string
  let mtimeMs: number | null = null
  try {
    ;[raw, mtimeMs] = await Promise.all([
      readFile(opts.path, 'utf8'),
      stat(opts.path).then((s) => s.mtimeMs),
    ])
  } catch {
    return {
      data: opts.fallback,
      available: false,
      generatedAt: null,
      ageMs: null,
      stale: false,
      error: null,
    }
  }

  let document: unknown
  try {
    document = JSON.parse(raw)
  } catch {
    logOnce(opts.path, 'unparseable JSON')
    return {
      data: opts.fallback,
      available: false,
      generatedAt: null,
      ageMs: null,
      stale: false,
      error: 'unparseable JSON',
    }
  }

  const isEnveloped =
    document !== null &&
    typeof document === 'object' &&
    'daedalusExport' in (document as Record<string, unknown>)

  let payload: unknown = document
  let generatedAt: string | null = null

  if (isEnveloped) {
    try {
      const head = decode(envelope, document)
      if (opts.acceptVersions !== undefined && !opts.acceptVersions.includes(head.schemaVersion)) {
        const msg = `schemaVersion ${String(head.schemaVersion)} not in [${opts.acceptVersions.join(', ')}]`
        logOnce(opts.path, msg)
        return {
          data: opts.fallback,
          available: false,
          generatedAt: head.generatedAt || null,
          ageMs: null,
          stale: false,
          error: msg,
        }
      }
      generatedAt = head.generatedAt || null
      payload = (document as Record<string, unknown>).data
    } catch (e) {
      const msg = e instanceof DecodeError ? e.message : 'malformed envelope'
      logOnce(opts.path, msg)
      return {
        data: opts.fallback,
        available: false,
        generatedAt: null,
        ageMs: null,
        stale: false,
        error: msg,
      }
    }
  }

  let data: T
  try {
    data = decode(opts.decoder, payload)
  } catch (e) {
    const msg = e instanceof DecodeError ? e.message : String(e)
    logOnce(opts.path, msg)
    return {
      data: opts.fallback,
      available: false,
      generatedAt,
      ageMs: null,
      stale: false,
      error: msg,
    }
  }

  const bornAt = generatedAt !== null ? Date.parse(generatedAt) : mtimeMs
  const ageMs = Number.isFinite(bornAt) ? Math.max(0, Date.now() - bornAt) : null
  return {
    data,
    available: true,
    generatedAt: generatedAt ?? new Date(mtimeMs).toISOString(),
    ageMs,
    stale: opts.maxAgeMs !== undefined && ageMs !== null && ageMs > opts.maxAgeMs,
    error: null,
  }
}
