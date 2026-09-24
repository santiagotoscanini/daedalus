import { arrayOf, bool, nullable, obj, optional, recordOf, str } from '../../lib/contract/decode'
import { type ModuleSwitch, STRUCTURAL_WHY, type WebOverride } from '../../lib/module-switch'
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
        exposeRemotely: optional(bool, false),
        aliases: optional(arrayOf(str), []),
      }),
    ),
    {},
  ),
  takenHostnames: optional(arrayOf(str), []),
})

const NONE: WebOverride = { label: null, public: null }

/** The label of a hostname under the base domain, or the whole hostname when it is not under it. */
function labelOf(hostname: string, domain: string): string {
  return hostname.endsWith(`.${domain}`) ? hostname.slice(0, -(domain.length + 1)) : hostname
}

/**
 * Which webApps a module publishes. By its containers — a webApp whose
 * serviceName is one of them — and by name, for the ones that dial a URL
 * (pihole, home-assistant, shelfmark) and have no serviceName to match. A
 * registry app's webApp (`app-<name>`) is never a module's: its hostname
 * and stage are the Apps page's, and are excluded by the container rule.
 */
function webAppsOf(
  id: string,
  containers: string[],
  webApps: Record<string, { serviceName: string | null }>,
): string[] {
  return Object.entries(webApps)
    .filter(
      ([name, w]) =>
        name === id ||
        (w.serviceName !== null && (containers.includes(w.serviceName) || w.serviceName === id)),
    )
    .map(([name]) => name)
    .sort()
}

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
      fallback: { webApps: {}, takenHostnames: [] },
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
  const desiredWeb = edit.desired.modules.web
  const committedWeb = edit.committed?.modules.web ?? {}
  const domain = ctx.site.baseDomain
  return Object.entries(running.data)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, on]) => {
      const containers = [
        ...new Set([...(id in images.data.pins ? [id] : []), ...(switches.data.stacks[id] ?? [])]),
      ]
      const web = webAppsOf(id, containers, publishing.data.webApps).map((name) => {
        const w = publishing.data.webApps[name] as (typeof publishing.data.webApps)[string]
        return {
          name,
          hostname: w.hostname,
          label: labelOf(w.hostname, domain),
          public: w.exposeRemotely,
          aliases: w.aliases,
          committed: committedWeb[name] ?? NONE,
          desired: desiredWeb[name] ?? NONE,
        }
      })
      return {
        id,
        running: on,
        desired: enabled[id] ?? on,
        switched: id in enabled,
        structural: structural.has(id),
        containers,
        hostnames: web.flatMap((w) => [w.hostname, ...w.aliases]),
        web,
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

/**
 * Move where one of a module's hostnames answers, or whether the tunnel
 * carries it, in the site draft. A field left undefined is not touched; null
 * puts it back to the host's word. The label is checked the way an app's
 * hostname is (lib/hostname.ts): one label under the base domain, not one
 * something else on the box already answers at, not a reserved one. A value
 * that equals what the box already publishes, with the committed document
 * silent on it, is the host's word again and leaves the document.
 */
export async function setModuleWeb(
  ctx: Ctx,
  id: string,
  name: string,
  patch: { label?: string | null; public?: boolean | null },
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const m = await moduleSwitch(ctx, id)
  if (m === null) return { ok: false, reason: `this box declares no module named ${id}` }
  const w = m.web.find((x) => x.name === name)
  if (w === undefined) return { ok: false, reason: `${id} publishes no hostname named ${name}` }

  const next: WebOverride = { ...w.desired }
  if (patch.label !== undefined) {
    const label = patch.label?.trim().toLowerCase() ?? null
    if (label !== null && label !== '') {
      const { hostnameError } = await import('../../lib/hostname')
      const own = [w.hostname, ...w.aliases]
      const taken = (await takenHostnames(ctx)).filter((h) => !own.includes(h))
      const why = hostnameError(ctx.site, `${label}.${ctx.site.baseDomain}`, taken)
      if (why !== null) return { ok: false, reason: why }
    }
    next.label = label === null || label === '' ? null : label
    if (next.label === w.label && w.committed.label === null) next.label = null
  }
  if (patch.public !== undefined) {
    next.public = patch.public
    if (next.public === w.public && w.committed.public === null) next.public = null
  }

  const edit = await siteEdit(ctx)
  const web = { ...edit.desired.modules.web }
  if (next.label === null && next.public === null) delete web[name]
  else web[name] = next
  await saveSiteEdit(ctx, { 'modules.web': web })
  return { ok: true }
}

async function takenHostnames(ctx: Ctx): Promise<string[]> {
  const publishing = await ctx.snapshot({
    path: ctx.exportPath('publishing.json'),
    decoder: publishingDecoder,
    fallback: { webApps: {}, takenHostnames: [] },
  })
  return publishing.data.takenHostnames
}
