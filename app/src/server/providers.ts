import type { Ctx } from '../core/ctx'
import { asValidator, bool, is, obj, withMessage } from '../lib/contract/decode'
import { nonBlankField } from '../lib/contract/fields'
import { isProviderKind, managesResidency, type ProviderKind } from '../lib/providers/kinds'
import { errorText } from '../lib/redact'
import type { Result } from '../lib/result'
import { adminFn } from './fn'

// The two things worth a button on a provider: put a model into the
// accelerator, and take it back out.
//
// Everything else about this system is edited as configuration and shipped
// by an Apply, which is right — config belongs in the flake. Residency is
// not config. A provider loads on demand and evicts the least recently used
// model when the card fills, so which weights are warm is RUNTIME state that
// drifts on its own, and the two things anyone ever wants to do about it are
// "free that card up" and "have this one ready, I am about to use it".
//
// ── deliberately not here ─────────────────────────────────────────────────
//
// Deleting a model from the provider's disk. Several of these are 14 GB
// downloads over a residential line and one took a hand-assembled
// three-checkpoint definition to register at all; that is not a thing to put
// one misclick away from a dashboard. Same for installing or removing a
// backend: those mutate the machine's runtimes, and the machine's own pages
// are where a machine is changed.
//
// ── why the browser never talks to the provider ───────────────────────────
//
// A model server has no auth on the LAN. daedalus is behind the identity
// gate, so routing these through a server function means the operator's
// passkey is what authorises the call — a fetch straight from the page would
// work just as well from any other tab on the LAN, gate or no gate. It is
// also why the page names a MACHINE and a KIND rather than an address: the
// address is resolved here, from the fleet's own provider list, so no
// browser can aim one of these at a host of its choosing.

export type ModelActionResult = Result<string>

type Target = { machine: string; kind: ProviderKind; model: string }

const kindField = withMessage(is(isProviderKind, 'a provider kind'), 'expected a provider kind')

/**
 * A model id, as a request may carry one.
 *
 * A shape check, not a list: the catalog lives at the provider and changes
 * when a model is registered there, so the authority on what may be loaded
 * is the provider, which answers a name it does not know with a 4xx that
 * `call` reports in words. What this refuses is a request that is not a name
 * at all — which would otherwise reach the provider as `{"model_name": null}`.
 */
const modelField = nonBlankField('expected a model')

/** The fields in the order they are checked: kind, machine, model. */
const targetShape = {
  kind: kindField,
  machine: nonBlankField('expected the machine the provider runs on'),
  model: modelField,
}

const target = withMessage(obj(targetShape), 'expected a provider and a model')

/** Absent and null both mean "nothing to put down first". */
const replacingField = (v: unknown, p: string): string | null =>
  v === undefined || v === null ? null : nonBlankField('expected the model being replaced')(v, p)

/**
 * Where that provider answers, as the fleet says — never as the caller does.
 *
 * Refuses a machine that offers no such provider, and a kind whose residency
 * the box does not drive, so neither a stale page nor a crafted request can
 * turn these into a POST at an arbitrary address.
 */
async function baseOf(t: Target, ctx: () => Promise<Ctx>): Promise<Result<string>> {
  const { fleetProviders } = await import('../host/providers/fleet')
  if (!managesResidency(t.kind)) {
    return { ok: false, reason: `a ${t.kind} provider does not load models on request` }
  }
  const hit = (await fleetProviders(await ctx())).find(
    (p) => p.machine === t.machine && p.kind === t.kind,
  )
  return hit === undefined
    ? { ok: false, reason: 'that machine offers no such provider' }
    : { ok: true, value: hit.base }
}

/**
 * Put a model down, freeing its accelerator memory and its file handle.
 *
 * The file-handle half comes up more often than the memory half: a model
 * that is loaded cannot be re-downloaded or replaced, so a stuck download is
 * frequently just this.
 */
export const unloadProviderModelFn = adminFn
  .validator(asValidator(target))
  .handler(async ({ data, context }): Promise<ModelActionResult> => {
    const base = await baseOf(data, context.ctx)
    if (!base.ok) return base
    return settled(await call(base.value, '/api/v1/unload', { model_name: data.model }))
  })

/**
 * Put a different model of the same kind into the slot.
 *
 * UNLOAD FIRST, and that is not belt-and-braces. The provider keeps a
 * per-kind pool — one model deep for every kind here — and a pinned model is
 * excluded from the eviction search. So when the pool is full and what is in
 * it is pinned, an explicit load evicts nothing: it fails with 409 and a
 * `slots_pinned_error`. A plain load-the-new-one button would have failed
 * every time it was pressed on a pinned slot.
 *
 * Freeing the slot explicitly is also the honest reading of the gesture: the
 * operator picked a replacement, so evicting the incumbent is what they
 * asked for, not a side effect to be inferred from memory pressure.
 *
 * `pinned` carries the incumbent's state forward rather than quietly
 * changing whether the slot survives the next squeeze.
 */
export const loadProviderModelFn = adminFn
  .validator(
    asValidator(
      withMessage(
        obj({
          ...targetShape,
          pinned: withMessage(bool, 'expected pinned to be true or false'),
          replacing: replacingField,
        }),
        'expected a provider and a model',
      ),
    ),
  )
  .handler(async ({ data, context }): Promise<ModelActionResult> => {
    const base = await baseOf(data, context.ctx)
    if (!base.ok) return base
    if (data.replacing !== null) {
      const freed = await call(base.value, '/api/v1/unload', { model_name: data.replacing })
      // Report the eviction failure rather than pressing on into the 409 it
      // guarantees — "could not free the slot" is the actionable sentence.
      if (!freed.ok) {
        return { ok: false, reason: `could not put ${data.replacing} down: ${freed.reason}` }
      }
    }
    return settled(
      await call(base.value, '/api/v1/load', { model_name: data.model, pinned: data.pinned }),
    )
  })

/**
 * POST, and report what happened in words.
 *
 * A load can take tens of seconds — a cold 12B model is read off a disk and
 * pushed across PCIe — so the budget here is far longer than the dashboard's
 * read timeouts, which exist to keep a dead upstream from stalling a page.
 * This is a deliberate action with a spinner on it; waiting is fine, silently
 * giving up at 2.5 s is not.
 */
async function call(
  base: string,
  path: string,
  body: Record<string, unknown>,
): Promise<ModelActionResult> {
  try {
    const res = await fetch(`${base.replace(/\/+$/, '')}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(120_000),
    })
    const said = await res.text()
    if (!res.ok) return { ok: false, reason: `the provider answered HTTP ${String(res.status)}` }
    const parsed = JSON.parse(said) as { message?: string; status?: string }
    // A 200 whose body says `status: error` is still a failure: a refused
    // load is reported that way rather than with a status code.
    const message = parsed.message ?? 'done'
    return parsed.status === 'error' ? { ok: false, reason: message } : { ok: true, value: message }
  } catch (e) {
    return { ok: false, reason: errorText(e) }
  }
}

/**
 * Forget the remembered catalog when a model moved.
 *
 * The readings are cached a minute so that a page visit and a sync tick do
 * not both dial the provider — but a load or an unload changes exactly what
 * that cache holds, and the page is about to re-run its loader. Without
 * this, the operator presses Switch, the provider does it, and the page
 * comes back showing the old slot for up to a minute.
 */
function settled(r: ModelActionResult): ModelActionResult {
  if (r.ok) void import('../host/providers/read').then((m) => m.forgetProviders())
  return r
}
