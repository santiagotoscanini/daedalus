// The awaited part of a loader, answered from memory.
//
// Every page here streams its slow work behind a skeleton, but each loader
// also AWAITS a few facts the frame is drawn from — the rail's rows, the
// theme, which machines exist and what OS each runs — and a navigation
// cannot start until those round trips return. In the lab that is 30 ms;
// on a dev server that has just recompiled, or a box that is busy, it is
// the click that seems to do nothing for a second.
//
// `known()` keeps the last answer for each key in this browser and hands
// it back at once on the next navigation, then reads again behind the
// page and, if the answer changed, asks the router to reload. Two rules
// keep that honest:
//
// - A reload the app itself asked for (`router.invalidate()` after a save)
//   must not be answered from memory: the whole point of that call is that
//   something changed. While such a reload's loaders run, `known()` reads
//   fresh.
// - An answer that changes on every read (a "seconds ago" field) would
//   reload the page on every navigation. A key whose value carries such a
//   field names what to compare with `fingerprint`.
//
// On the server there is no memory and no navigation: every read is fresh.

type Router = { invalidate: (opts?: never) => Promise<void> }

const store = new Map<string, unknown>()
let router: Router | null = null
let fresh = false

/** Called once by getRouter(): wraps `invalidate` so a save reads fresh. */
export function attachRouter(r: Router): void {
  router = r
  const invalidate = r.invalidate.bind(r)
  r.invalidate = () => {
    fresh = true
    return invalidate().finally(() => {
      fresh = false
    })
  }
}

export async function known<T>(
  key: string,
  read: () => Promise<T>,
  fingerprint: (v: T) => string = (v) => JSON.stringify(v),
): Promise<T> {
  if (typeof window === 'undefined' || fresh) {
    const v = await read()
    store.set(key, v)
    return v
  }
  const hit = store.get(key)
  const reading = read().then((v) => {
    const changed = store.has(key) && fingerprint(store.get(key) as T) !== fingerprint(v)
    store.set(key, v)
    if (changed) void router?.invalidate()
    return v
  })
  if (store.has(key)) {
    // The refresh's failure is not this navigation's: the page has an
    // answer, and the next read will try again.
    reading.catch(() => {})
    return hit as T
  }
  return reading
}

/** Drop a remembered answer, for the rare mutation that does not invalidate. */
export function forget(key: string): void {
  store.delete(key)
}
