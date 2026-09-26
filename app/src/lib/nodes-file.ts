import { arrayOf, type Decoder, decode, int, obj, optional, recordOf, str } from './contract/decode'

// `site/nodes.json`: the machines that joined this box, as nix needs them.
//
// A node is a Postgres row — its key, its state, its policy, what it last
// said about itself — and most of that nothing nix builds from. What nix
// DOES build from is here, and only that: which machines exist, what each is
// called on the network, what OS it runs, and which providers it offers on
// which ports. gatus probes a provider's health from it, the log bridge
// scrapes a lemonade node from it, and LiteLLM's base URL is a node's name.
// No MAC and no address: the household's device inventory is kept out of
// every git history on purpose, and the address is the lease's — pi-hole
// gives the lease the name (host/node-targets.ts writes the line that does),
// so `<name>.<lan domain>` follows the machine wherever the pool puts it.
//
// Rendered by an Apply like apps.json (host/apply-flow.ts), read back by
// platform/site.nix as `fleet.nodes`, and its schema versions live under
// `site-formats/nodes/v<N>/`.

export const NODES_SCHEMA_VERSION = 1

/** A DNS label: what a node is called on the network. */
export const NODE_NAME_RE = /^[a-z0-9]([a-z0-9-]{0,30}[a-z0-9])?$/

type NodesFileNode = {
  id: string
  name: string
  os: string
  /** Offered providers only, by kind, each with the port it answers on. */
  providers: Record<string, { port: number }>
}

export type NodesFile = { schemaVersion: number; nodes: NodesFileNode[] }

/**
 * A DNS label from a hostname: lowercase, anything else a hyphen, runs
 * collapsed, ends trimmed, at most 32 characters. "Santiago's MacBook Pro
 * (2)" → "santiagos-macbook-pro-2". Empty input names nothing.
 */
export function slugOf(hostname: string): string {
  return hostname
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 32)
    .replace(/-+$/g, '')
}

/** What an approved node contributes; the caller has already resolved its policy. */
export type NodeForFile = {
  id: string
  name: string
  os: string
  providers: Record<string, { port: number; offer: boolean }>
}

export function renderNodesFile(nodes: readonly NodeForFile[]): string {
  const doc: NodesFile = {
    schemaVersion: NODES_SCHEMA_VERSION,
    nodes: [...nodes]
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
      .map((n) => ({
        id: n.id,
        name: n.name,
        os: n.os,
        providers: Object.fromEntries(
          Object.entries(n.providers)
            .filter(([, p]) => p.offer)
            .sort(([a], [b]) => (a < b ? -1 : 1))
            .map(([kind, p]) => [kind, { port: p.port }]),
        ),
      })),
  }
  return `${JSON.stringify(doc, null, 2)}\n`
}

const nodeDecoder = obj({
  id: str,
  name: str,
  os: str,
  providers: optional(recordOf(obj({ port: int })), {}),
})

const nodesFileDecoder: Decoder<NodesFile> = obj({
  schemaVersion: int,
  nodes: arrayOf(nodeDecoder),
})

/** A committed nodes.json, or an Error naming what is wrong with it. */
export function parseNodesFile(raw: unknown): NodesFile {
  const parsed = decode(nodesFileDecoder, raw)
  if (parsed.schemaVersion !== NODES_SCHEMA_VERSION) {
    throw new Error(
      `nodes.json: schemaVersion ${String(parsed.schemaVersion)} is not ${String(NODES_SCHEMA_VERSION)}`,
    )
  }
  const seen = new Set<string>()
  for (const n of parsed.nodes) {
    if (!NODE_NAME_RE.test(n.name)) throw new Error(`nodes.json: "${n.name}" is not a DNS label`)
    if (seen.has(n.name)) throw new Error(`nodes.json: two nodes are called "${n.name}"`)
    seen.add(n.name)
  }
  return parsed
}
