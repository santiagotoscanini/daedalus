import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './bridge'
import { env } from './env'

// The approved nodes as Prometheus scrape targets.
//
// Every agent answers `/metrics` on its status port (agent/src/telemetry.rs).
// The box's Prometheus config is nix-generated and cannot know which
// machines were approved after the last rebuild, so the nodes reach it the
// way Prometheus itself provides for: file-based discovery. This writes
// `<apply dir>/nodes/targets.json` in file_sd's shape, and the daedalus nix
// module mounts that directory into the prometheus container and points a
// `nodes` job at it (`fleet.prometheusFileSd.nodes`). Prometheus re-reads
// the file on change, so an approval scrapes within its refresh interval
// and a revoke stops it — no rebuild.
//
// Rewritten whole on every change that could move a target: approve,
// revoke, forget, a policy change, and a hello whose address differs from
// the last. The dnsmasq lines below ride the same writes.

export type NodeTarget = {
  id: string
  hostname: string
  name: string
  os: string
  lanIp: string
  statusPort: number
}

export function targetsDocument(nodes: NodeTarget[]): string {
  const doc = nodes.map((n) => ({
    targets: [`${n.lanIp}:${String(n.statusPort)}`],
    labels: {
      node: n.id,
      // `host` matches the label the agent's own metrics carry, so the two
      // agree; `machine` is what the pages call it.
      host: n.hostname,
      machine: n.name,
      os: n.os,
    },
  }))
  return `${JSON.stringify(doc, null, 2)}\n`
}

const applyDir = (): string => env.get('APPLY_DIR') ?? '/apply'

export async function writeNodeTargets(nodes: NodeTarget[]): Promise<void> {
  const dir = join(applyDir(), 'nodes')
  await mkdir(dir, { recursive: true })
  await writeAtomic(join(dir, 'targets.json'), targetsDocument(nodes))
}

/** Whether the document has ever been written; a hello seeds it when not. */
export function nodeTargetsMissing(): boolean {
  return !existsSync(join(applyDir(), 'nodes', 'targets.json'))
}

/* ── the dnsmasq lines ─────────────────────────────────────────────────── */

// How a machine gets its name on the network. pi-hole's dnsmasq gives a
// lease the hostname a `dhcp-host=<MAC>,<name>` line names, over whatever
// the client sent, so `<name>.lan` follows the machine to any address the
// pool hands it. The box writes one line per approved node here, the
// daedalus nix module copies the file into the directory pi-hole reads as
// `dhcp-hostsdir` and reloads FTL (a HUP, no restart), and no rebuild is
// involved — a join must not cost one, and a MAC must not enter git.
//
// The household's own reservations (the encrypted dhcp-hostsfile, which the
// network page reads a copy of at DHCP_HOSTS_PATH) win: a MAC that file
// names gets no line here, so dnsmasq never sees the same machine twice.

export type DhcpHost = {
  id: string
  mac: string
  name: string
  /** Present only when the policy pins the address. */
  lanIp: string | null
}

export function dhcpHostsDocument(hosts: readonly DhcpHost[]): string {
  const lines = [...hosts]
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
    .map((h) => (h.lanIp === null ? `${h.mac},${h.name}` : `${h.mac},${h.lanIp},${h.name}`))
  return lines.length === 0 ? '' : `${lines.join('\n')}\n`
}

export async function writeDhcpHosts(hosts: readonly DhcpHost[]): Promise<void> {
  const dir = join(applyDir(), 'nodes')
  await mkdir(dir, { recursive: true })
  await writeAtomic(join(dir, 'dhcp-hosts'), dhcpHostsDocument(hosts))
}

const MAC_RE = /^([0-9a-f]{2}:){5}[0-9a-f]{2}$/

/** The MACs a dnsmasq hostsfile names, lowercased; comments and blanks skipped. */
export function macsOf(text: string): Set<string> {
  const out = new Set<string>()
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (line === '' || line.startsWith('#')) continue
    for (const field of line.split(',')) {
      const f = field.trim().toLowerCase()
      if (MAC_RE.test(f)) out.add(f)
    }
  }
  return out
}

/** The household reservations' MACs; empty when there is no file to read. */
export async function householdMacs(): Promise<Set<string>> {
  try {
    return macsOf(await readFile(env.get('DHCP_HOSTS_PATH') ?? '/dhcp/hosts', 'utf8'))
  } catch {
    return new Set()
  }
}
