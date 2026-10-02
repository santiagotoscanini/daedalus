import type { Ctx } from '../../core/ctx'
import { DEFAULT_PORT } from '../../lib/providers/kinds'
import { errorText } from '../../lib/redact'
import type { Result } from '../../lib/result'
import type { PowerWanted } from '../controller/generated'
import type { NodePolicy, ProviderPolicy } from '../schema'

// Lemonade's lifecycle on a machine, from the box: install or update it to a
// pinned release, start or stop it, keep it starting on its own. One body for
// AI › Providers' buttons (server/providers.ts) and the MCP write tools
// (host/mcp/server.ts), each bringing its actor.
//
// Policy first, verb second. The pin, `wanted` and `alwaysOn` are the
// machine's policy (host/schema.ts `ProviderPolicy`), written through the one
// policy writer (core/nodes.ts `setNodePolicy`) and handed to the controller
// before the verb goes: the agent refuses an install of any release but the
// pinned one, and holds a machine to `wanted` between verbs. The verb is what
// acts now and gives the page a request id to follow (`actions.get`).

/** A verb sent: the request its outcome is reported under, and the release it installs. */
export type LifecycleSent = Result<{ request: string; version: string | null }>

type Entry = ProviderPolicy

/** The approved machine's row, or why the verb would go nowhere. */
async function approved(id: string) {
  const { nodeById } = await import('../../lib/repo/nodes')
  const row = await nodeById(id)
  return row === undefined || row.state !== 'approved' ? null : row
}

/** Write lemonade's entry with `change` over what is stored, then hand the set to the controller. */
async function setLemonade(
  ctx: Ctx,
  id: string,
  policy: NodePolicy | null,
  change: Partial<Entry>,
  actor: string,
): Promise<void> {
  const { setNodePolicy } = await import('../../core/nodes')
  const { syncDesired } = await import('../controller/nodes')
  const stored = policy?.providers?.lemonade
  const entry: Entry = {
    port: stored?.port ?? DEFAULT_PORT.lemonade,
    offer: stored?.offer ?? false,
    ...stored,
    ...change,
  }
  await setNodePolicy(
    ctx,
    id,
    { set: { providers: { ...policy?.providers, lemonade: entry } }, unset: [] },
    actor,
  )
  // Awaited, so the machine holds the new policy before the verb reaches it.
  await syncDesired(ctx)
}

/**
 * Whether the machine's agent speaks install and power, and so reports the
 * install, its process and its startup: null when it has not said hello since
 * the controller started, or the controller did not answer. An agent that
 * predates them sends a report with those fields empty, which says nothing of
 * the install; the pages must not read it as "none".
 */
export async function speaksLifecycle(
  ctx: Pick<Ctx, 'controller'>,
  id: string,
): Promise<boolean | null> {
  const detail = await ctx.controller.call('nodes.get', { id, full: false }).catch(() => null)
  const hello = detail?.hello ?? null
  return hello === null ? null : hello.capabilities.includes('providers.lifecycle')
}

/** The machine's hello, when its agent speaks the lifecycle verbs. */
async function lifecycleHello(ctx: Ctx, id: string) {
  const detail = await ctx.controller.call('nodes.get', { id, full: false })
  const hello = detail.hello
  if (hello === null) {
    return {
      ok: false as const,
      reason: 'the machine has not connected since the controller started',
    }
  }
  if (!hello.capabilities.includes('providers.lifecycle')) {
    return {
      ok: false as const,
      reason: 'its agent predates install and power; update the agent first',
    }
  }
  return { ok: true as const, value: hello }
}

/**
 * Install or update Lemonade on `machine` to `version` (the newest stable
 * release when absent): resolve the asset for its OS, pin it, send the install.
 */
export async function installLemonade(
  ctx: Ctx,
  args: { machine: string; version?: string },
  actor: string,
): Promise<LifecycleSent> {
  const { resolveLemonadeRelease } = await import('./lemonade-release')
  const row = await approved(args.machine)
  if (row === null) return { ok: false, reason: 'no approved machine by that id' }
  try {
    const hello = await lifecycleHello(ctx, args.machine)
    if (!hello.ok) return hello
    const pin = await resolveLemonadeRelease(
      {
        os: hello.value.os,
        arch: hello.value.arch,
        osName: hello.value.facts.os_name,
        osVersion: hello.value.facts.os_version,
      },
      args.version,
    )
    if (!pin.ok) return pin
    await setLemonade(ctx, args.machine, row.policy, { pin: pin.value }, actor)
    const sent = await ctx.controller.call('nodes.provider_install', {
      id: args.machine,
      kind: 'lemonade',
      ...pin.value,
    })
    return { ok: true, value: { request: sent.request, version: pin.value.version } }
  } catch (e) {
    return { ok: false, reason: errorText(e) }
  }
}

/** Start or stop Lemonade on `machine`, and keep it so (`wanted`). */
export async function powerLemonade(
  ctx: Ctx,
  args: { machine: string; wanted: PowerWanted },
  actor: string,
): Promise<LifecycleSent> {
  const row = await approved(args.machine)
  if (row === null) return { ok: false, reason: 'no approved machine by that id' }
  try {
    const hello = await lifecycleHello(ctx, args.machine)
    if (!hello.ok) return hello
    await setLemonade(ctx, args.machine, row.policy, { wanted: args.wanted }, actor)
    const sent = await ctx.controller.call('nodes.provider_power', {
      id: args.machine,
      kind: 'lemonade',
      wanted: args.wanted,
    })
    return { ok: true, value: { request: sent.request, version: null } }
  } catch (e) {
    return { ok: false, reason: errorText(e) }
  }
}

/** Start Lemonade with the user's logon (Windows) or the boot, or not: policy only. */
export async function setLemonadeAlwaysOn(
  ctx: Ctx,
  args: { machine: string; on: boolean },
  actor: string,
): Promise<Result<null>> {
  const row = await approved(args.machine)
  if (row === null) return { ok: false, reason: 'no approved machine by that id' }
  try {
    await setLemonade(ctx, args.machine, row.policy, { alwaysOn: args.on }, actor)
    return { ok: true, value: null }
  } catch (e) {
    return { ok: false, reason: errorText(e) }
  }
}
