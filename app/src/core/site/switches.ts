import { arrayOf, bool, nullable, obj, optional, recordOf, str } from '../../lib/contract/decode'
import { type ModuleSwitch, STRUCTURAL_WHY } from '../../lib/module-switch'
import type { Ctx } from '../ctx'
import { saveSiteEdit, siteEdit } from './index'

// Switching a module off from its page — and back on.
//
// A stack's switch is `fleet.modules.<id>.enable`, and the only thing the
// control plane may write is site.json: `modules.enabled.<id>` becomes that
// switch on the next Apply, at a priority the host's own files yield to
// (platform/site.nix). What this file adds is the judgement nix cannot make
// before an Apply: which ids exist on this box, which may never be switched,
// and what a switch takes with it — the containers, the hostnames, the rail
// entry — so the confirmation says it before the operator agrees to it.
//
// Three exports feed that. `/export/modules.json` is every switch the box
// declares with its value as built; `/export/switches.json` is the list a
// running box cannot do without and the log-stack registry, stack →
// containers; `/export/images.json` names the pinned containers, which is
// how a stack's own container (the one with the stack's name, absent from
// the log registry) is counted. Hostnames come from the publishing export: a
// webApp whose serviceName is one of the stack's containers stops answering
// with it. The shape and the reasons are lib/module-switch.ts, client-safe.

export type { ModuleSwitch } from '../../lib/module-switch'

const switchesDecoder = obj({
  structural: optional(arrayOf(str), []),
  stacks: optional(recordOf(arrayOf(str)), {}),
})

const imagesDecoder = obj({ pins: optional(recordOf(obj({})), {}) })

const publishingDecoder = obj({
  webApps: optional(
    recordOf(
      obj({
        hostname: str,
        serviceName: optional(nullable(str), null),
        aliases: optional(arrayOf(str), []),
      }),
    ),
    {},
  ),
})

export async function moduleSwitches(ctx: Ctx): Promise<ModuleSwitch[]> {
  const [running, switches, publishing, images, edit] = await Promise.all([
    ctx.snapshot({
      path: ctx.exportPath('modules.json'),
      decoder: recordOf(bool),
      fallback: {} as Record<string, boolean>,
    }),
    ctx.snapshot({
      path: ctx.exportPath('switches.json'),
      decoder: switchesDecoder,
      fallback: { structural: [], stacks: {} },
    }),
    ctx.snapshot({
      path: ctx.exportPath('publishing.json'),
      decoder: publishingDecoder,
      fallback: { webApps: {} },
    }),
    ctx.snapshot({
      path: ctx.exportPath('images.json'),
      decoder: imagesDecoder,
      fallback: { pins: {} },
    }),
    siteEdit(ctx),
  ])
  const structural = new Set(switches.data.structural)
  const enabled = edit.desired.modules.enabled
  return Object.entries(running.data)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, on]) => {
      const containers = [
        ...new Set([...(id in images.data.pins ? [id] : []), ...(switches.data.stacks[id] ?? [])]),
      ]
      const hostnames = Object.values(publishing.data.webApps)
        .filter(
          (w) =>
            w.serviceName !== null && (containers.includes(w.serviceName) || w.serviceName === id),
        )
        .flatMap((w) => [w.hostname, ...w.aliases])
      return {
        id,
        running: on,
        desired: enabled[id] ?? on,
        switched: id in enabled,
        structural: structural.has(id),
        containers,
        hostnames,
      }
    })
}

export async function moduleSwitch(ctx: Ctx, id: string): Promise<ModuleSwitch | null> {
  return (await moduleSwitches(ctx)).find((m) => m.id === id) ?? null
}

/**
 * Move one switch in the site draft. Refused, with the reason, for an id the
 * box does not declare and for a structural one; putting a switch back to
 * what the host's own files say removes it from the document, so the file
 * carries only what the operator moved.
 */
export async function setModuleEnabled(
  ctx: Ctx,
  id: string,
  enabled: boolean,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const all = await moduleSwitches(ctx)
  const m = all.find((x) => x.id === id)
  if (m === undefined) return { ok: false, reason: `this box declares no module named ${id}` }
  if (m.structural && !enabled) {
    const why = STRUCTURAL_WHY[id]
    return {
      ok: false,
      reason: `${id} stays on: ${why ?? 'a running box cannot do without it'}`,
    }
  }
  const edit = await siteEdit(ctx)
  const next = { ...edit.desired.modules.enabled }
  // The running value is the host's word only while the document is silent;
  // once it speaks, "back to what it was" is an explicit value again.
  const committedSays = edit.committed?.modules.enabled[id]
  if (committedSays === undefined && enabled === m.running) delete next[id]
  else next[id] = enabled
  await saveSiteEdit(ctx, { 'modules.enabled': next })
  return { ok: true }
}
