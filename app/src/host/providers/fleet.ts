import type { Ctx } from '../../core/ctx'
import { DEFAULT_PORT, type ProviderKind } from '../../lib/providers/kinds'
import { listNodes, type NodeRow, netNameOf, providersOf } from '../../lib/repo/nodes'
import { networkFacts } from '../contract/domains/network'
import { type ProviderReading, readProvider } from './read'

// Every provider on the network, as one list: this box's own, and each
// approved node's offered ones, each with the address the gateway dials.
// The AI page draws it; the gateway sync reconciles from it.
//
// Server-side by nature and so under host/: the node list is a database
// read and the readings dial the LAN. The pure half — what a kind is, what
// the operator said about a model — stays in lib/providers, where a
// component may import it.

/**
 * What `<name>.<domain>` uses when the export does not carry a domain: the
 * same default platform/nodes.nix declares. Named rather than inlined so a
 * fallback in a LiteLLM route is greppable when one turns out to be wrong.
 */
export const LAN_DOMAIN_FALLBACK = 'lan'

/**
 * The LAN domain the box publishes, or the default with a note that it was
 * assumed. Every node address is built from this, so a silent guess here is
 * a gateway full of routes to hostnames that do not resolve.
 */
export async function lanDomain(): Promise<{ domain: string; assumed: boolean }> {
  const facts = await networkFacts()
  return facts.lanDomain === ''
    ? { domain: LAN_DOMAIN_FALLBACK, assumed: true }
    : { domain: facts.lanDomain, assumed: false }
}

export type FleetProvider = {
  /** 'box' for this machine, else the node's id. */
  machine: string
  /** The machine as the pages name it. */
  machineName: string
  os: string
  kind: ProviderKind
  /** Scheme, host and port; the kind knows the path. */
  base: string
  /** Whether the operator offers it to the gateway (Settings › Machines). */
  offered: boolean
}

/**
 * The box as a provider: subgen, when the tv stack runs it. Reached the way
 * every host-netns service is, through the host gateway alias, never the
 * LAN address.
 */
function boxProviders(ctx: Ctx): FleetProvider[] {
  if (!ctx.modules.enabled('tv')) return []
  return [
    {
      machine: 'box',
      machineName: 'this box',
      os: 'linux',
      kind: 'subgen',
      base: `${ctx.hosts.hc}:${String(DEFAULT_PORT.subgen)}`,
      offered: false,
    },
  ]
}

/**
 * A node's providers: every kind its policy knows, offered or not, so the
 * page can say "not offered" and "not answering" apart. Presence as the
 * agent reports it lives in the node's telemetry document, read by the
 * page beside this; the reader here asks the provider itself.
 */
function nodeProviders(n: NodeRow, domain: string): FleetProvider[] {
  const name = netNameOf(n)
  const policy = providersOf(n.policy)
  return (Object.entries(policy) as [ProviderKind, { port: number; offer: boolean }][]).map(
    ([kind, p]) => ({
      machine: n.id,
      machineName: n.name,
      os: n.os,
      kind,
      base: `http://${name}.${domain}:${String(p.port)}`,
      offered: p.offer,
    }),
  )
}

/** Every provider, this box first, then the nodes in the order they joined. */
export async function fleetProviders(ctx: Ctx): Promise<FleetProvider[]> {
  const [nodes, { domain }] = await Promise.all([
    listNodes().then((all) => all.filter((n) => n.state === 'approved')),
    lanDomain(),
  ])
  return [...boxProviders(ctx), ...nodes.flatMap((n) => nodeProviders(n, domain))]
}

/** The providers with what each answered, read in parallel. */
export async function readFleetProviders(
  ctx: Ctx,
): Promise<{ provider: FleetProvider; reading: ProviderReading }[]> {
  const providers = await fleetProviders(ctx)
  return Promise.all(
    providers.map(async (provider) => ({
      provider,
      reading: await readProvider(ctx, provider.kind, provider.base),
    })),
  )
}
