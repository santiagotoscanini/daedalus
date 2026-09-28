import type { Ctx } from '../core/ctx'
import type { ModelAction } from '../host/controller/generated'
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
// ── how a verb travels ───────────────────────────────────────────────────
//
// Through the controller, never at the machine: `nodes.provider_model`
// hands the verb to the machine's agent, which runs it against its provider
// on its own loopback (agent/src/providers.rs `residency`) and reports the
// outcome in its next providers document under the request id this call
// gets back — reading again at once, so the document that carries the
// outcome also shows the slot as it now is. This call waits for that
// outcome, as long as a load may take.
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
// ── why the browser never names an address ────────────────────────────────
//
// The page names a MACHINE and a KIND; the machine's agent finds its
// provider by kind and its policy's port. Nothing a browser sends can aim a
// request at a host, and the verb goes through the identity gate like every
// other admin action.

export type ModelActionResult = Result<string>

type Target = { machine: string; kind: ProviderKind; model: string }

const kindField = withMessage(is(isProviderKind, 'a provider kind'), 'expected a provider kind')

/**
 * A model id, as a request may carry one.
 *
 * A shape check, not a list: the catalog lives at the provider and changes
 * when a model is registered there, so the authority on what may be loaded
 * is the provider, which answers a name it does not know with a refusal the
 * outcome reports in words. What this refuses is a request that is not a
 * name at all.
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
 * Refuses a machine that offers no such provider, and a kind whose residency
 * the box does not drive, so a stale page cannot send a verb nowhere.
 */
async function checked(t: Target, ctx: Ctx): Promise<Result<null>> {
  const { fleetProviders } = await import('../host/providers/fleet')
  if (!managesResidency(t.kind)) {
    return { ok: false, reason: `a ${t.kind} provider does not load models on request` }
  }
  const hit = (await fleetProviders(ctx)).find((p) => p.machine === t.machine && p.kind === t.kind)
  return hit === undefined || hit.machine === 'box'
    ? { ok: false, reason: 'that machine offers no such provider' }
    : { ok: true, value: null }
}

/** How long a verb may take on the machine: a cold 12B model is read off a disk and pushed across PCIe. */
const OUTCOME_WITHIN_MS = 150_000
const POLL_MS = 500

/**
 * Hand the verb to the machine and wait for its outcome in the providers
 * document. A deliberate action with a spinner on it: waiting is fine,
 * silently giving up early is not.
 */
async function run(
  ctx: Ctx,
  t: Target,
  verb: { action: ModelAction; pinned?: boolean; replacing?: string },
): Promise<ModelActionResult> {
  const ok = await checked(t, ctx)
  if (!ok.ok) return ok
  let request: string
  try {
    ;({ request } = await ctx.controller.nodesProviderModel(t.machine, {
      kind: t.kind,
      model: t.model,
      ...verb,
    }))
  } catch (e) {
    return { ok: false, reason: errorText(e) }
  }
  const until = Date.now() + OUTCOME_WITHIN_MS
  while (Date.now() < until) {
    await new Promise((r) => setTimeout(r, POLL_MS))
    const answer = await ctx.controller.nodesProviders(t.machine).catch(() => null)
    const done = answer?.providers?.flatMap((p) => p.actions).find((a) => a.request === request)
    if (done !== undefined) {
      return done.ok ? { ok: true, value: done.message } : { ok: false, reason: done.message }
    }
  }
  return {
    ok: false,
    reason: `no outcome from the machine within ${String(OUTCOME_WITHIN_MS / 1000)} s`,
  }
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
  .handler(
    async ({ data, context }): Promise<ModelActionResult> =>
      run(await context.ctx(), data, { action: 'unload' }),
  )

/**
 * Put a different model of the same kind into the slot.
 *
 * The machine UNLOADS FIRST, and that is not belt-and-braces. The provider
 * keeps a per-kind pool — one model deep for every kind here — and a pinned
 * model is excluded from the eviction search. So when the pool is full and
 * what is in it is pinned, an explicit load evicts nothing: it fails with
 * 409. Freeing the slot is also the honest reading of the gesture: the
 * operator picked a replacement.
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
  .handler(
    async ({ data, context }): Promise<ModelActionResult> =>
      run(await context.ctx(), data, {
        action: 'load',
        pinned: data.pinned,
        ...(data.replacing === null ? {} : { replacing: data.replacing }),
      }),
  )
