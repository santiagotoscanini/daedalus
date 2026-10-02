import type { Ctx } from '../../../core/ctx'
import type { PowerWanted } from '../../../host/controller/generated'
import { type FleetProvider, readFleetProviders } from '../../../host/providers/fleet'
import { type GatewayRoute, gatewayRoutes } from '../../../host/providers/gateway'
import { lemonadeUpdate } from '../../../host/providers/lemonade-release'
import { speaksLifecycle } from '../../../host/providers/lifecycle'
import type { ProviderDetail, ProviderManaged } from '../../../host/providers/read'
import type { ProviderPolicy } from '../../../host/schema'
import {
  type ModelFigures,
  managesResidency,
  PROVIDER_NAME,
  type ProviderKind,
  type ProviderModel,
} from '../../../lib/providers/kinds'
import { resolveModel } from '../../../lib/providers/policy'
import { listAppsLight } from '../../../lib/repo/apps'
import { listNodes } from '../../../lib/repo/nodes'

// The Providers tab: every machine on the network that offers models, read
// from what each machine's agent reported through the controller (the box's
// own subgen from itself), with the chain it feeds drawn once at the top.
//
// One loader answers for every machine and the view picks by `?machine=`:
// the whole fleet's catalog is small, the reports are the controller's in
// memory, and a switch in the picker is then a re-render, not a round trip.
//
// A row is a machine-and-kind, the shape the fleet has underneath; with
// Lemonade the only kind a node offers (lib/providers/kinds.ts says why),
// that is one row per machine. The kind stays in `id` because the gateway
// sync tags a route with both, and because a machine that one day runs two
// model servers must not silently show one of them.

export type CatalogEntry = ProviderModel & {
  /** The name the gateway publishes it under, per the operator's policy. */
  alias: string
  /** Offered to the gateway: the provider is, the policy says so, and it is on disk. */
  offerable: boolean
  /** A route in the gateway already forwards to this id on this machine. */
  routed: string | null
  /** Resident at the provider right now, with what it says about the slot. */
  loaded: { device: string | null; maxContext: number | null; pinned: boolean } | null
  /** What it has managed at the provider, or null if it has not run there. */
  figures: ModelFigures | null
}

export type ProviderMachine = {
  /** 'box', or the node's id. */
  machine: string
  /** `<machine>:<kind>`: what identifies a row, a pill and the `?machine=` value. */
  id: string
  name: string
  os: string
  kind: ProviderKind
  kindName: string
  base: string
  /** Its own window for a browser (`FleetProvider.ui`); null when there is none to open. */
  ui: string | null
  offered: boolean
  reachable: boolean
  version: string | null
  error: string | null
  /** Whether this box may load and unload models here, or only read them. */
  manageable: boolean
  /** The machine has reported its providers; always true for the box. */
  reported: boolean
  /** What the agent found: running, or installed and silent; null with no report of it. */
  presence: { running: boolean; version: string | null } | null
  models: CatalogEntry[]
  /** How many models the gateway would carry from here. */
  offerableCount: number
  detail: ProviderDetail
  /** The install and how it runs, as the agent last reported them; null for the box or without a report. */
  managed: ProviderManaged | null
  /**
   * Its agent speaks install and power, so `managed` is what it found rather
   * than fields an older agent leaves empty; null without a hello (and for the box).
   */
  speaksLifecycle: boolean | null
  /**
   * What the box asks of it (the policy): the pinned release, run or not,
   * start on its own. Null for this box's own, which has no lifecycle here.
   */
  asked: { pin: string | null; wanted: PowerWanted | null; alwaysOn: boolean | null } | null
  /** The newest stable release and how many it runs behind; null when there is nothing to update. */
  update: { latest: string | null; behind: number } | null
}

export type Chain = {
  providers: { machines: number; reachable: number; offerable: number }
  gateway: {
    configured: boolean
    routes: number
    synced: number
    fromConfig: number
    error: string | null
  }
  consumers: { name: string; kind: 'ui' | 'automation' | 'app'; note: string }[]
}

export type ProvidersData = {
  machines: ProviderMachine[]
  chain: Chain
  /** The machine the picker opens on when the URL names none. */
  defaultMachine: string | null
  /**
   * The one provider whose own log this box ships, and the Loki stack label
   * it arrives under. A model server off this box has no container here to
   * select logs by: a bridge reads its WebSocket and pushes to Loki.
   */
  logs: { machine: string; stack: string } | null
}

function routedBy(routes: GatewayRoute[], p: FleetProvider, id: string): string | null {
  const host = (() => {
    try {
      const u = new URL(p.base)
      return u.port === '' ? u.hostname : `${u.hostname}:${u.port}`
    } catch {
      return p.base
    }
  })()
  const hit = routes.find(
    (r) =>
      (r.daedalus !== null && r.daedalus.node === p.machine && r.daedalus.id === id) ||
      (r.daedalus === null && r.upstream.replace(/^[^/]+\//, '') === id && r.host === host),
  )
  return hit?.alias ?? null
}

export async function loadProviders(ctx: Ctx): Promise<ProvidersData> {
  const [read, gateway, apps, nodes] = await Promise.all([
    readFleetProviders(ctx),
    gatewayRoutes(ctx),
    listAppsLight().catch(() => []),
    listNodes(ctx).catch(() => []),
  ])
  // A node's provider policy: its models' curation — the same policy the
  // gateway sync resolves against, so the alias this page prints and the one
  // the gateway publishes cannot disagree — and its lifecycle.
  const policyOf = (p: FleetProvider): ProviderPolicy | undefined =>
    p.machine === 'box'
      ? undefined
      : nodes.find((n) => n.id === p.machine)?.policy.providers?.[p.kind]

  const speaks = await Promise.all(
    read.map(({ provider }) =>
      provider.machine === 'box' ? null : speaksLifecycle(ctx, provider.machine),
    ),
  )

  const updates = await Promise.all(
    read.map(({ provider, reading }) =>
      provider.kind === 'lemonade' && provider.machine !== 'box'
        ? lemonadeUpdate(reading.health.version ?? reading.presence?.version ?? null).catch(
            () => null,
          )
        : null,
    ),
  )

  const machines: ProviderMachine[] = read.map(({ provider, reading }, i) => {
    const policy = policyOf(provider)
    const { detail } = reading
    const policies = policy?.models
    const models: CatalogEntry[] = reading.models.map((m) => {
      const r = resolveModel(policies, m)
      const live = reading.health.loaded.find((l) => l.id === m.id)
      return {
        ...m,
        mode: r.mode,
        alias: r.alias,
        offerable: provider.offered && r.offer,
        routed: routedBy(gateway.routes, provider, m.id),
        loaded:
          live === undefined
            ? null
            : { device: live.device, maxContext: live.maxContext, pinned: live.pinned },
        figures: detail.figures[m.id] ?? null,
      }
    })
    return {
      machine: provider.machine,
      id: `${provider.machine}:${provider.kind}`,
      name: provider.machineName,
      os: provider.os,
      kind: provider.kind,
      kindName: PROVIDER_NAME[provider.kind],
      base: provider.base,
      ui: provider.ui,
      offered: provider.offered,
      reachable: reading.reachable,
      reported: reading.reported,
      version: reading.health.version ?? reading.presence?.version ?? null,
      error: reading.error,
      manageable: managesResidency(provider.kind),
      presence: reading.presence,
      models,
      offerableCount: models.filter((m) => m.offerable).length,
      detail,
      managed: reading.managed,
      speaksLifecycle: speaks[i] ?? null,
      asked:
        provider.machine === 'box'
          ? null
          : {
              pin: policy?.pin?.version ?? null,
              wanted: policy?.wanted ?? null,
              alwaysOn: policy?.alwaysOn ?? null,
            },
      update: updates[i] ?? null,
    }
  })

  const synced = gateway.routes.filter((r) => r.daedalus !== null).length
  const consumers: Chain['consumers'] = [
    ...(ctx.modules.enabled('open-webui')
      ? [
          {
            name: 'Open WebUI',
            kind: 'ui' as const,
            note: 'the chat window; lists what the gateway publishes',
          },
        ]
      : []),
    ...(ctx.modules.enabled('n8n')
      ? [{ name: 'n8n', kind: 'automation' as const, note: 'workflows that call a model' }]
      : []),
    ...apps
      .filter((a) => a.litellm)
      .map((a) => ({ name: a.name, kind: 'app' as const, note: 'holds a gateway key' })),
  ]

  // The picker opens on the machine with the most to show: an offered,
  // reachable provider first, then whatever answers, then the first row.
  const pick =
    machines.find((m) => m.offered && m.reachable) ??
    machines.find((m) => m.reachable) ??
    machines[0]

  return {
    machines,
    chain: {
      providers: {
        machines: machines.length,
        reachable: machines.filter((m) => m.reachable).length,
        offerable: machines.reduce((n, m) => n + m.offerableCount, 0),
      },
      gateway: {
        configured: gateway.configured,
        routes: gateway.routes.length,
        synced,
        fromConfig: gateway.routes.length - synced,
        error: gateway.error,
      },
      consumers,
    },
    defaultMachine: pick?.id ?? null,
    logs: logsFor(ctx, machines),
  }
}

/**
 * Which provider the log bridge is pointed at, if the box runs one.
 *
 * ONE bridge, one target, so the panel belongs to one machine — drawn under
 * every Lemonade, it would tell a second machine its logs were being shipped
 * when they are not. The rule mirrors the bridge's own (`lib.head
 * config.fleet.lemonadeNodes`, stacks/lemonade-logs): nodes.json is written sorted by
 * id and carries only offered providers, so the first offered Lemonade in
 * id order is the one the bridge reads.
 */
function logsFor(ctx: Ctx, machines: ProviderMachine[]): ProvidersData['logs'] {
  if (!ctx.modules.enabled('lemonade-logs')) return null
  const target = machines
    .filter((m) => m.machine !== 'box' && m.kind === 'lemonade' && m.offered)
    .sort((a, b) => (a.machine < b.machine ? -1 : 1))[0]
  return target === undefined ? null : { machine: target.machine, stack: 'lemonade' }
}
