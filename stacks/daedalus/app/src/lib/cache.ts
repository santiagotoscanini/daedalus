// The one cache under every slow-or-rationed upstream read.
//
// This app deliberately caches almost nothing — the request coalescer in
// lib/http.ts is explicitly not a cache, because a dashboard's numbers have
// to be live. What DOES get cached is the reads where staleness is free and
// the upstream is either rationed (GitHub's 60 unauthenticated requests an
// hour) or slow out of proportion to how often its answer changes (release
// lists move weekly; an icon probe walks six paths). Before this module each
// of those sites hand-rolled its own map-and-timestamp, and the two-clock
// stale-serving below existed in some of them — which is how one of them
// quietly loses it.
//
// ── the two-clock contract ────────────────────────────────────────────────
//
// Success and failure want different treatment, so there are two clocks:
//
//   `at`    — when the last SUCCESSFUL load landed. Fresh data is reused for
//             the full `ttlMs`.
//   `tried` — when the last attempt was made, successful or not. A failure
//             does NOT discard what we already had: it only marks the
//             attempt, the previous answer keeps being served, and the next
//             real try waits out `retryMs`.
//
// The failure mode this exists for is the rate limit: without stale-serving,
// exhausting GitHub's budget replaces every release panel with an error for a
// quarter of an hour, which looks like the feature is broken rather than like
// one fetch was throttled. And `retryMs` is deliberately shorter than the
// TTL — a refusal is usually a window closing, and those reopen soon — but
// not zero, which is what "retry on every render" amounts to and is
// precisely how a window stays shut.
//
// A load signals failure by returning `null` (the same convention as
// lib/http.ts). A cache whose loads never return null is therefore a plain
// TTL cache, and its `get` never returns null either — the types follow the
// load's own.

type Slot = { at: number; tried: number; value: unknown }

export type SwrCache = {
  get<T>(key: string, load: () => Promise<T>): Promise<T>
  /**
   * Drop a key, so the next read reloads — for the moment right after an
   * action that changes the answer (a deploy landing, a secret being set),
   * where serving the pre-action state for a TTL reads as the button having
   * done nothing.
   */
  forget(key: string): void
}

export function swrCache(opts: { ttlMs: number; retryMs?: number }): SwrCache {
  const slots = new Map<string, Slot>()
  const retryMs = opts.retryMs ?? 0

  return {
    async get<T>(key: string, load: () => Promise<T>): Promise<T> {
      const hit = slots.get(key)
      const now = Date.now()

      if (hit !== undefined) {
        const fresh = hit.value !== null && now - hit.at < opts.ttlMs
        const backingOff = now - hit.tried < retryMs
        // Sound even though the slot is untyped: everything stored came out
        // of this key's own load, so a non-null value IS a T, and a null one
        // can only exist where the load's T admits null.
        if (fresh || backingOff) return hit.value as T
      }

      const value = await load()
      if (value !== null) {
        slots.set(key, { at: now, tried: now, value })
        return value
      }

      slots.set(key, { at: hit?.at ?? 0, tried: now, value: hit?.value ?? null })
      return (hit?.value ?? null) as T
    },

    forget(key: string): void {
      slots.delete(key)
    },
  }
}

/** The same contract for a cache of exactly one thing (a snapshot file). */
export function swrValue<T>(
  opts: { ttlMs: number; retryMs?: number },
  load: () => Promise<T>,
): () => Promise<T> {
  const c = swrCache(opts)
  return () => c.get('', load)
}
