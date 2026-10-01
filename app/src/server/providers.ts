import type { Ctx } from '../core/ctx'
import type { ActionOutcome, ModelAction } from '../host/controller/generated'
import { asValidator, bool, is, obj, withMessage } from '../lib/contract/decode'
import { nodeIdField, nonBlankField } from '../lib/contract/fields'
import { isProviderKind, managesResidency, type ProviderKind } from '../lib/providers/kinds'
import { errorText } from '../lib/redact'
import type { Result } from '../lib/result'
import { adminFn, readFn } from './fn'

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
// on its own loopback (agent/src/providers/lemonade.rs `residency`) and reports the
// outcome in its next providers document under the request id this call
// gets back — reading again at once, so the document that carries the
// outcome also shows the slot as it now is. The page follows that id with
// `fetchProviderActionFn` (lib/follow-request.ts): the wait is the browser's,
// and no request is held open for as long as a load may take.
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

/** The request id the outcome will be reported under, or why the verb was not sent. */
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

/**
 * Hand the verb to the machine: its request id, or why it was not sent. The
 * outcome rides the machine's next providers document under that id.
 */
async function send(
  ctx: Ctx,
  t: Target,
  verb: { action: ModelAction; pinned?: boolean; replacing?: string },
): Promise<ModelActionResult> {
  const ok = await checked(t, ctx)
  if (!ok.ok) return ok
  // A machine's agent drives lemonade alone (`checked` refused the rest).
  if (t.kind !== 'lemonade') return { ok: false, reason: `a ${t.kind} provider is not a machine's` }
  try {
    const { request } = await ctx.controller.call('nodes.provider_model', {
      id: t.machine,
      kind: t.kind,
      model: t.model,
      ...verb,
    })
    return { ok: true, value: request }
  } catch (e) {
    return { ok: false, reason: errorText(e) }
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
      send(await context.ctx(), data, { action: 'unload' }),
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
      send(await context.ctx(), data, {
        action: 'load',
        pinned: data.pinned,
        ...(data.replacing === null ? {} : { replacing: data.replacing }),
      }),
  )

/**
 * How one residency request stands, from the machine's providers document:
 * its ending, or null while the document does not list it yet. Only an ending
 * is ever listed — the agent reports a verb once it has run.
 */
export const fetchProviderActionFn = readFn
  .validator(
    asValidator(
      withMessage(
        obj({ machine: nodeIdField, request: nonBlankField('expected a request id') }),
        'expected a machine and a request id',
      ),
    ),
  )
  .handler(async ({ data, context }): Promise<ActionOutcome | null> => {
    const ctx = await context.ctx()
    return ctx.controller.call('actions.get', { node: data.machine, request: data.request })
  })
