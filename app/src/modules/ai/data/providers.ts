import type { Ctx } from '../../../core/ctx'
import { type FleetProvider, readFleetProviders } from '../../../host/providers/fleet'
import { type GatewayRoute, gatewayRoutes } from '../../../host/providers/gateway'
import { loadNodeSystem } from '../../../lib/dashboard/node-system'
import {
  defaultAlias,
  PROVIDER_NAME,
  type ProviderKind,
  type ProviderModel,
} from '../../../lib/providers/kinds'
import { listApps } from '../../../lib/repo/apps'

// The Providers tab: every machine on the network that offers models, read
// from the provider itself, with the chain it feeds drawn once at the top.
//
// One loader answers for every machine and the view picks by `?machine=`:
// three machines' worth of catalog is small, the provider reads are
// remembered a minute, and a switch in the picker is then a re-render, not
// a round trip.

export type ProviderMachine = {
  /** 'box', or the node's id. */
  machine: string
  /** `<machine>:<kind>`: a machine may offer more than one provider, so the
      pair is what identifies a row, a pill and the `?machine=` value. */
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
  /** What the agent said on its last tick, for a node with agent 0.11.0+. */
  presence: { running: boolean; version: string | null } | null
  loaded: { id: string; device: string | null; maxContext: number | null; pinned: boolean }[]
  models: (ProviderModel & {
    alias: string
    /** Offered to the gateway: the provider is, and the model is on disk. */
    offerable: boolean
    /** A route in the gateway already forwards to this id on this machine. */
    routed: string | null
  })[]
  /** How many models the gateway would carry from here. */
  offerableCount: number
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
  const [read, gateway, apps] = await Promise.all([
    readFleetProviders(ctx),
    gatewayRoutes(ctx),
    listApps().catch(() => []),
  ])
  const machines: ProviderMachine[] = await Promise.all(
    read.map(async ({ provider, reading }) => {
      const models = reading.models.map((m) => ({
        ...m,
        alias: defaultAlias(m.id),
        offerable: provider.offered && m.downloaded,
        routed: routedBy(gateway.routes, provider, m.id),
      }))
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
        presence: await presenceOf(provider.machine, provider.kind),
        loaded: reading.health.loaded,
        models,
        offerableCount: models.filter((m) => m.offerable).length,
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
  }
}
