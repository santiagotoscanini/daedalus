import { existsSync } from 'node:fs'
import { mkdir } from 'node:fs/promises'
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
// revoke, forget, and a hello whose address differs from the last.

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
