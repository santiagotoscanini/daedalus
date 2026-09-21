import { makeCtx } from '../../core/ctx'
import { listExternalApps } from '../../core/settings/external-apps'
import { appIcon, siteIcon } from '../../host/app-icon'
import { readApplyStatus } from '../../host/apply'
import { appStatuses } from '../../host/metrics'
import { manifestEntries } from '../../host/nix-manifest'
import { readWorkspaceRequestStatus, readWorkspaces, workspaceFor } from '../../host/workspaces'
import { effectiveHostname } from '../hostname'
import { driftOf, listApps } from '../repo/apps'
import { stageExposed } from '../stage'

// Everything the Apps list page shows: the registry rows, the off-box
// projects beside them, and the three live facts a row draws — whether the
// app is answering, whether it has drifted from nix, and whether its icon can
// be fetched.
//
// Static imports here, not the seam's dynamic ones: `src/lib/apps/` is a
// server region (host/boundary.test.ts), so nothing in this file can reach a
// browser, and the whole module is loaded by one `await import` in
// server/registry.ts.

export async function loadAppList() {
  // Independent reads — the registry rows and the manifest file — fetched
  // together rather than one behind the other.
  const [records, entries] = await Promise.all([listApps(), manifestEntries()])
  const manifest = new Map(entries.map((m) => [m.name, m]))
  const ctx = await makeCtx()
  const EXTERNAL_APPS = await listExternalApps(ctx)
  const [statuses, applyStatus, icons, externalIcons, workspaces, workspaceStatus] =
    await Promise.all([
      // Degrades per-app rather than rejecting, so a prometheus outage costs
      // the status column, not the page.
      appStatuses(records.map((r) => r.name)),
      readApplyStatus(),
      // Resolved per app, in parallel, and cached for an hour in that module —
      // so this costs one round of probes after a restart and nothing after.
      Promise.all(
        records.map(
          async (r) =>
            (await appIcon(
              r.name,
              effectiveHostname(ctx.site, r.name, r.hostname),
              stageExposed(r.stage),
            )) !== null,
        ),
      ),
      Promise.all(EXTERNAL_APPS.map(async (e) => (await siteIcon(e.id, e.host)) !== null)),
      readWorkspaces(),
      readWorkspaceRequestStatus(),
    ])

  return {
    applyStatus,
    workspaceStatus,
    // The off-box projects (GitHub Pages / Vercel). Static data plus two
    // probed facts — whether the site serves an icon, and whether a
    // workspace on this box already holds the repo — so the row can draw a
    // monogram instead of a broken image and a clone button that tells the
    // truth.
    external: EXTERNAL_APPS.map((e, i) => ({
      ...e,
      hasIcon: externalIcons[i] ?? false,
      workspace: e.repo === null ? null : workspaceFor(e.repo, workspaces.data),
    })),
    apps: records.map((r, i) => ({
      name: r.name,
      stage: r.stage,
      managedInNix: r.managedInNix,
      sourceMode: r.sourceMode,
      description: r.description,
      hasIcon: icons[i] ?? false,
      hostname: effectiveHostname(ctx.site, r.name, r.hostname),
      authMode: r.authMode,
      postgres: r.postgres,
      drift: driftOf(r, manifest.get(r.name)),
      status: statuses[r.name] ?? {
        state: 'unknown' as const,
        containerUp: null,
        healthy: null,
        rpm: null,
        spark: [],
      },
    })),
  }
}
