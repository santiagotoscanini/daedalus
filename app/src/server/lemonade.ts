import { createServerFn } from '@tanstack/react-start'

// The two things worth a button on the Lemonade tab.
//
// Everything else about this system is edited as configuration and shipped by
// an Apply, which is right: config belongs in the flake. VRAM residency is not
// config. Lemonade loads a model on demand and evicts the least recently used
// one when the card fills, so which models are warm is a RUNTIME state that
// drifts on its own — and the two things you ever want to do about it are
// "free that card up" and "keep this one warm, I am about to use it".
//
// Doing either meant opening Lemonade's own GUI on the gaming PC, which is the
// exact detour /etc/nixos/lemonade.md tells us to skip: it is one API call.
//
// ── deliberately not here ─────────────────────────────────────────────────
//
// `POST /api/v1/delete` removes a model from disk — several of these are 14 GB
// downloads over a residential line, and one of them (Chroma) took a
// hand-assembled three-checkpoint definition to register at all. That is not a
// thing to put one misclick away from a dashboard. Same for the backend
// install/uninstall endpoints: they mutate the Windows box's runtimes.
//
// ── why the browser never talks to Lemonade ───────────────────────────────
//
// Lemonade has no auth on the LAN. daedalus is behind the Pocket ID gate, so
// routing these through a server function means the operator's passkey is what
// authorises the call — a fetch straight from the page would work just as well
// from any other tab on the LAN, gate or no gate.

const BASE = () => process.env.LEMONADE_URL ?? ''

export type ModelActionResult = { ok: boolean; message: string }

/**
 * Load a model into VRAM, optionally pinning it there.
 *
 * `pinned` is the whole point of the warm button: without it the model is
 * evicted again the moment something else needs the card, which for a 12B chat
 * model means the next request pays a cold load. `save_options` is left off so
 * a pin from here is for this session and does not rewrite the server's
 * persisted per-model defaults.
 */
export const loadLemonadeModel = createServerFn({ method: 'POST' })
  .inputValidator((input: { model: string; pinned: boolean }) => input)
  .handler(async ({ data }): Promise<ModelActionResult> => {
    return call('/api/v1/load', { model_name: data.model, pinned: data.pinned })
  })

/**
 * Evict a model, freeing its VRAM and releasing its file handle.
 *
 * The file-handle half matters more often than the VRAM half: a model that is
 * loaded cannot be re-downloaded or replaced on the Windows box, so a stuck
 * download is frequently just this.
 */
export const unloadLemonadeModel = createServerFn({ method: 'POST' })
  .inputValidator((input: { model: string }) => input)
  .handler(async ({ data }): Promise<ModelActionResult> => {
    return call('/api/v1/unload', { model_name: data.model })
  })

/**
 * Put a different model of the same kind into the slot.
 *
 * UNLOAD FIRST, and that is not belt-and-braces. Lemonade keeps a per-type LRU
 * pool — one model deep for every type on this box — and pinned models are
 * excluded from the eviction candidate search. So when the pool is full and
 * everything in it is pinned, an explicit load does not evict anything: it
 * fails with 409 and a `slots_pinned_error`. Every resident model here is
 * pinned, so a plain load-the-new-one button would have failed every single
 * time it was pressed.
 *
 * Freeing the slot explicitly is also the honest reading of the gesture. The
 * user picked a replacement; evicting the incumbent is what they asked for,
 * not a side effect to be inferred from memory pressure.
 *
 * `pinned` carries the incumbent's state forward: switching should not quietly
 * change whether the slot survives the next squeeze.
 */
export const switchLemonadeModel = createServerFn({ method: 'POST' })
  .inputValidator((input: { from: string | null; to: string; pinned: boolean }) => input)
  .handler(async ({ data }): Promise<ModelActionResult> => {
    if (data.from !== null) {
      const freed = await call('/api/v1/unload', { model_name: data.from })
      // Report the eviction failure rather than pressing on into the 409 it
      // guarantees — "could not free the slot" is the actionable sentence.
      if (!freed.ok) return { ok: false, message: `could not evict ${data.from}: ${freed.message}` }
    }
    return call('/api/v1/load', { model_name: data.to, pinned: data.pinned })
  })

/**
 * POST, and report what happened in words.
 *
 * A load can take tens of seconds — a cold 12B model is read off a spinning
 * disk and pushed across PCIe — so the budget here is far longer than the
 * dashboard's read timeouts, which exist to keep a dead upstream from stalling
 * a page. This is a deliberate action with a spinner on it; waiting is fine,
 * silently giving up at 2.5s is not.
 */
async function call(path: string, body: Record<string, unknown>): Promise<ModelActionResult> {
  try {
    const res = await fetch(`${BASE()}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const text = await res.text()
    if (!res.ok) return { ok: false, message: `Lemonade answered HTTP ${String(res.status)}` }

    const parsed = JSON.parse(text) as { message?: string; status?: string }
    return { ok: parsed.status !== 'error', message: parsed.message ?? 'done' }
  } catch (e) {
    return { ok: false, message: e instanceof Error ? e.message : 'request failed' }
  }
}
