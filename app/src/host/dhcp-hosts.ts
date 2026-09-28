import { existsSync } from 'node:fs'
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeAtomic } from './bridge'
import { env } from './env'

// How a machine gets its name on the network. pi-hole's dnsmasq gives a
// lease the hostname a `dhcp-host=<MAC>,<name>` line names, over whatever
// the client sent, so `<name>.<lanDomain>` follows the machine to any address
// the pool hands it. The box writes one line per approved node to
// `<apply dir>/nodes/dhcp-hosts`, nix/stacks/daedalus/daedalus-nodes.nix
// copies the file into the directory pi-hole reads as `dhcp-hostsdir` and
// reloads FTL (a HUP, no restart), and no rebuild is involved — a join must
// not cost one, and a MAC must not enter git.
//
// Rewritten whole on every change that could move a line: approve, revoke,
// forget, a policy change, and an address or a MAC the controller saw move
// (lib/repo/nodes.ts `publishDhcpHosts`).
//
// The household's own reservations (the encrypted dhcp-hostsfile, which the
// network page reads a copy of at DHCP_HOSTS_PATH) win: a MAC that file
// names gets no line here, so dnsmasq never sees the same machine twice.

const applyDir = (): string => env.get('APPLY_DIR') ?? '/apply'

/** Whether the file has ever been written; the minute's observation seeds it when not. */
export function dhcpHostsMissing(): boolean {
  return !existsSync(join(applyDir(), 'nodes', 'dhcp-hosts'))
}

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
