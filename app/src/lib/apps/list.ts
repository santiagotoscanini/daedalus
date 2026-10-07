import type { Ctx } from '../../core/ctx'
import { offbox } from '../../core/offbox'
import { appIcon, siteIcon } from '../../host/app-icon'
import { readApplyStatus } from '../../host/apply'
import { manifestEntries } from '../../host/nix-manifest'
import { readWorkspaces, workspaceFor } from '../../host/workspaces'
import { effectiveHostname } from '../hostname'
import { listApps } from '../repo/apps'
import { appReachable } from '../stage'
import { latestDeploy } from './deployments'
import { asDeclared, driftOf } from './manifest-map'
import { appStatuses } from './metrics'

// Everything the Apps list page shows: the registry rows, the off-box
// projects beside them, and the three live facts a row draws — whether the
// app is answering, whether it has drifted from nix, and whether its icon can
// be fetched.
//
// Static imports here, not the seam's dynamic ones: `src/lib/apps/` is a
// server region (host/boundary.test.ts), so nothing in this file can reach a
// browser, and the whole module is loaded by one `await import` in
// server/registry.ts.

export async function loadAppList(ctx: Ctx) {
  // Independent reads — the registry rows and the manifest file — fetched
  // together rather than one behind the other.
  const [rows, entries] = await Promise.all([listApps(), manifestEntries()])
  const manifest = new Map(entries.map((m) => [m.name, m]))
  const records = rows.map((r) => asDeclared(r, manifest.get(r.name)))
  const { sites: EXTERNAL_APPS, status: offboxStatus } = await offbox(ctx)
  const [statuses, applyStatus, icons, externalIcons, workspaces, deploys] = await Promise.all([
    // Degrades per-app rather than rejecting, so a prometheus outage costs
    // the status column, not the page.
    appStatuses(
      ctx,
      records.map((r) => r.name),
    ),
    readApplyStatus(ctx),
    // Resolved per app, in parallel, and cached for an hour in that module —
    // so this costs one round of probes after a restart and nothing after.
    Promise.all(
      records.map(
        async (r) =>
          (await appIcon(
            r.name,
            effectiveHostname(ctx.site, r.name, r.hostname),
            appReachable(r),
          )) !== null,
      ),
    ),
    Promise.all(EXTERNAL_APPS.map(async (e) => (await siteIcon(e.id, e.host)) !== null)),
    readWorkspaces(),
    // One small file per app (deploy.sh's journal), so the list can say
    // when each app last changed without a query per row.
    Promise.all(records.map((r) => latestDeploy(ctx, r.name).catch(() => null))),
  ])

  return {
    applyStatus,
    // The off-box projects (GitHub Pages / Vercel), as the two platforms
    // report them, plus two probed facts — whether the site serves an
    // icon, and whether a workspace on this box already holds the repo — so
    // the row can draw a monogram instead of a broken image and a clone
    // button that tells the truth. `offboxStatus` says why a platform shows
    // fewer rows than it might: not connected, a permission not granted.
    offboxStatus,
    external: EXTERNAL_APPS.map((e, i) => ({
      ...e,
      hasIcon: externalIcons[i] ?? false,
      workspace: e.repo === null ? null : workspaceFor(e.repo, workspaces.data),
    })),
    apps: records.map((r, i) => ({
      name: r.name,
      stage: r.stage,
      // Not on the box yet: awaiting its first image, or the Apply after it.
      isNew: !r.managedInNix && (r.awaitingImage || manifest.get(r.name)?.awaitingImage !== false),
      managedInNix: r.managedInNix,
      sourceMode: r.sourceMode,
      description: r.description,
      hasIcon: icons[i] ?? false,
      hostname: effectiveHostname(ctx.site, r.name, r.hostname),
      authMode: r.authMode,
      postgres: r.postgres,
      drift: driftOf(r, manifest.get(r.name)),
      deployed: deploys[i] ?? null,
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
