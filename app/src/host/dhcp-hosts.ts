import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Ctx } from '../core/ctx'
import { env } from './env'
import { rootAnswerText, runRoot } from './root'

// How a machine gets its name on the network. pi-hole's dnsmasq gives a
// lease the hostname a `dhcp-host=<MAC>,<name>` line names, over whatever
// the client sent, so `<name>.<lanDomain>` follows the machine to any address
// the pool hands it. The box hands one line per approved node to the root
// helper's `nodes-dhcp` (nix/stacks/daedalus/daedalus-nodes.nix), which keeps
// them in the verbs directory, copies them into the directory pi-hole reads
// as `dhcp-hostsdir` and reloads FTL (a HUP, no restart), and no rebuild is
// involved — a join must not cost one, and a MAC must not enter git.
//
// Rendered whole on every change that could move a line: approve, revoke,
// forget, a policy change, and an address or a MAC the controller saw move
// (core/nodes.ts `publishDhcpHosts`) — and handed over only when the lines
// differ from the kept copy, since each run reloads pi-hole (`writeDhcpHosts`).
//
// The household's own reservations (the encrypted dhcp-hostsfile, which the
// network page reads a copy of at DHCP_HOSTS_PATH) win: a MAC that file
// names gets no line here, so dnsmasq never sees the same machine twice.

/** The lines the host kept from the last run: root's, read-only here. */
const keptPath = (): string => join(env.get('VERBS_DIR') ?? '/verbs', 'nodes-dhcp-hosts')

/** The helper waits a minute for the unit (daedalus-nodes.nix); this is that and slack. */
const NODES_DHCP_WAIT_MS = 130_000

/** Whether the lines were ever handed over; the minute's observation seeds them when not. */
export async function dhcpHostsMissing(): Promise<boolean> {
  return (await readFile(keptPath(), 'utf8').catch(() => null)) === null
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

/**
 * Hand the lines to the host, unless it already keeps exactly them: every
 * run reloads pi-hole (a HUP to FTL, which resolves for the whole house), so
 * a save that moves no line — a switch, a display name — must not start one.
 * True when it handed them over; throws with the helper's words when the
 * host would not take them.
 */
export async function writeDhcpHosts(
  ctx: Pick<Ctx, 'controller'>,
  hosts: readonly DhcpHost[],
): Promise<boolean> {
  const body = dhcpHostsDocument(hosts)
  const held = await readFile(keptPath(), 'utf8').catch(() => null)
  if (held === body) return false
  const answer = await runRoot(ctx, 'nodes-dhcp', {}, NODES_DHCP_WAIT_MS, body)
  if (answer.outcome !== 'done') throw new Error(rootAnswerText(answer, 'nodes-dhcp'))
  return true
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
