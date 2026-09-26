import type { Ctx } from '../../../core/ctx'
import { NO_DETAIL, type ProviderDetail, readProviderDetail } from '../../../host/providers/detail'
import { type FleetProvider, readFleetProviders } from '../../../host/providers/fleet'
import { type GatewayRoute, gatewayRoutes } from '../../../host/providers/gateway'
import { loadNodeSystem } from '../../../lib/dashboard/node-system'
import {
  managesResidency,
  PROVIDER_NAME,
  type ProviderKind,
  type ProviderModel,
} from '../../../lib/providers/kinds'
import type { ModelFigures } from '../../../lib/providers/metrics'
import { type ModelPolicies, resolveModel } from '../../../lib/providers/policy'
import { listApps } from '../../../lib/repo/apps'
import { listNodes } from '../../../lib/repo/nodes'

// The Providers tab: every machine on the network that offers models, read
// from the provider itself, with the chain it feeds drawn once at the top.
//
// One loader answers for every machine and the view picks by `?machine=`:
// the whole fleet's catalog is small, the provider reads are remembered a
// minute, and a switch in the picker is then a re-render, not a round trip.
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
  offered: boolean
  reachable: boolean
  version: string | null
  error: string | null
  /** Whether this box may load and unload models here, or only read them. */
  manageable: boolean
  /** What the agent said on its last tick, for a node with agent 0.11.0+. */
  presence: { running: boolean; version: string | null } | null
  models: CatalogEntry[]
  /** How many models the gateway would carry from here. */
  offerableCount: number
  detail: ProviderDetail
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
      (r.daedalus === null && r.upstream === `openai/${id}` && r.host === host),
  )
  return hit?.alias ?? null
}

async function presenceOf(machine: string, kind: ProviderKind) {
  if (machine === 'box') return null
  const sys = await loadNodeSystem(machine).catch(() => null)
  const p = sys?.telemetry?.providers.find((x) => x.kind === kind)
  return p === undefined ? null : { running: p.running, version: p.version }
}

export async function loadProviders(ctx: Ctx): Promise<ProvidersData> {
  const [read, gateway, apps, nodes] = await Promise.all([
    readFleetProviders(ctx),
    gatewayRoutes(ctx),
    listApps().catch(() => []),
    listNodes().catch(() => []),
  ])
  // The same policy the gateway sync resolves against, so the alias this
  // page prints and the alias the gateway publishes cannot disagree.
  const policiesOf = (p: FleetProvider): ModelPolicies | undefined =>
    p.machine === 'box'
      ? undefined
      : nodes.find((n) => n.id === p.machine)?.policy.providers?.[p.kind]?.models

  const machines: ProviderMachine[] = await Promise.all(
    read.map(async ({ provider, reading }) => {
      const [detail, presence] = await Promise.all([
        reading.reachable
          ? readProviderDetail(ctx, provider.kind, provider.base)
          : Promise.resolve(NO_DETAIL),
        presenceOf(provider.machine, provider.kind),
      ])
      const policies = policiesOf(provider)
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
        offered: provider.offered,
        reachable: reading.reachable,
        version: reading.health.version,
        error: reading.error,
        manageable: managesResidency(provider.kind),
        presence,
        models,
        offerableCount: models.filter((m) => m.offerable).length,
        detail,
      }
    }),
  )

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
