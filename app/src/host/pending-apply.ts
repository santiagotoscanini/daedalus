import { makeCtx } from '../core/ctx'
import { driftOf, listApps } from '../lib/repo/apps'
import { type ApplyStatus, readApplyStatus } from './apply'
import { manifestEntries } from './nix-manifest'

// Everything the next Apply would do, in the Apply bar's vocabulary — for the
// bar in the root layout, which every page without its own shows.
//
// An Apply writes every file and rebuilds once, so the bar has to say all of
// it wherever it is drawn: the apps that drifted from nix, the site document
// (settings, a service's cog, a game server's roster), and the machines. The
// Apps list says the same from its own loader; this is that sum without the
// list's icons and probes, which the bar does not need.

export type PendingApply = {
  changed: { name: string; fields: string[] }[]
  status: ApplyStatus
}

export async function pendingApply(): Promise<PendingApply> {
  const ctx = await makeCtx()
  const { siteEdit } = await import('../core/site')
  const { siteBarFields } = await import('../lib/module-switch')
  const { nodesChange } = await import('./apply-flow')
  const [records, entries, site, nodes, status] = await Promise.all([
    listApps(),
    manifestEntries(),
    siteEdit(ctx),
    nodesChange(),
    readApplyStatus(),
  ])
  const manifest = new Map(entries.map((m) => [m.name, m]))
  const siteFields = siteBarFields(site.changes, site.moduleChanges)
  return {
    changed: [
      ...records
        .filter((r) => !r.managedInNix)
        .map((r) => ({ name: r.name, fields: driftOf(r, manifest.get(r.name)) }))
        .filter((a) => a.fields.length > 0),
      ...(siteFields.length > 0 ? [{ name: 'site', fields: siteFields }] : []),
      ...(nodes.changed && nodes.fields.length > 0
        ? [{ name: 'nodes', fields: nodes.fields }]
        : []),
    ],
    status,
  }
}
