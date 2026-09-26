import { appIcon } from '../../host/app-icon'
import { readApplyStatus } from '../../host/apply'
import { siteIdentity } from '../../host/contract/domains/site'
import { lastDeploy, pullFailing, readDeployStatus } from '../../host/deploy'
import { env } from '../../host/env'
import { appStatuses } from '../../host/metrics'
import { hostnamesTakenBy, manifestEntries, operatorSecretApps } from '../../host/nix-manifest'
import { readSite } from '../../host/site'
import { readWorkspaceRequestStatus, readWorkspaces, workspaceFor } from '../../host/workspaces'
import { deployShot as readDeployShot } from '../dashboard/shotter'
import { effectiveHostname } from '../hostname'
import { driftOf, getApp } from '../repo/apps'
import { appRepo, defaultImage } from '../site'
import { stageExposed } from '../stage'

// The app detail page's frame: the record, whether it has drifted from nix,
// and the live signals the hero draws. Null for a name the registry does not
// know — the route renders its own not-found rather than this inventing one.
//
// Deliberately NOT the per-tab payload (./tabs.ts): this is the registry row
// plus one parallel round of status, snapshot and probe reads, and the page
// cannot render at all without it, since the tab bar depends on whether the
// app has a database or an egress container. The expensive part is the tab.

export async function loadAppDetail(data: { name: string }) {
  const { name } = data

  const [record, entries] = await Promise.all([getApp(name), manifestEntries()])
  if (!record) return null

  const manifest = entries.find((m) => m.name === name)

  const box = readSite()
  const hostname = effectiveHostname(box, record.name, record.hostname)

  // Every app repo lives under the box's owner, keyed by the app's name — the same
  // assumption the build service and the create flow make. True for the
  // local-mode entry too: daedalus's repo is the flake repo, which carries
  // its name.
  const repo = appRepo(box, record.name)

  const [
    statuses,
    applyStatus,
    deploy,
    pullBroken,
    deployStatus,
    takenHostnames,
    hasIcon,
    workspaces,
    workspaceStatus,
    deployShot,
    site,
  ] = await Promise.all([
    appStatuses([name]),
    readApplyStatus(),
    lastDeploy(name),
    pullFailing(name),
    readDeployStatus(),
    // So the hostname field can reject a collision as it is typed rather
    // than during the rebuild it would otherwise fail.
    hostnamesTakenBy(hostname),
    appIcon(record.name, hostname, stageExposed(record.stage)).then((icon) => icon !== null),
    readWorkspaces(),
    readWorkspaceRequestStatus(),
    readDeployShot(name),
    siteIdentity(),
  ])

  return {
    applyStatus,
    deployStatus,
    repo,
    workspace: workspaceFor(repo, workspaces.data),
    // From the snapshot when it has published, from the env binding before
    // the first publish — same value, different freshness.
    workspaceRoot: workspaces.data.root || (env.get('WORKSPACE_ROOT') ?? ''),
    // Where an app's data dir lives on the host, for the one panel that
    // names it (what a removal leaves behind). From the export, so the
    // path is the nix fact rather than a string typed into a component.
    stateRoot: site.data.stateRoot,
    workspaceStatus,
    takenHostnames,
    // Authoritative record from the app's own deploy unit — a deploy also
    // runs from the timer and from a manual systemctl start, neither of
    // which goes through daedalus.
    lastDeploy: deploy,
    pullBroken,
    // The post-deploy screenshot pointer — the Overview's Vercel card.
    deployShot,
    drift: driftOf(record, manifest),
    status: statuses[name] ?? null,
    app: {
      name: record.name,
      stage: record.stage,
      managedInNix: record.managedInNix,
      sourceMode: record.sourceMode,
      deployEnable: record.deployEnable,
      image: record.image,
      effectiveImage: record.image ?? defaultImage(box, record.name),
      hostname: record.hostname,
      effectiveHostname: hostname,
      description: record.description,
      hasIcon,
      postgres: record.postgres,
      storage: record.storage,
      litellm: record.litellm,
      prometheus: record.prometheus,
      // From Nix, not the record: the file's presence is the setting, so
      // there is no column for this and nothing that could drift from it.
      operatorSecrets: (await operatorSecretApps()).includes(name),
      limitCpus: record.limitCpus,
      limitMemoryMb: record.limitMemoryMb,
      limitPids: record.limitPids,
      authMode: record.authMode,
      authHealthPath: record.authHealthPath,
      authIsolated: record.authIsolated,
      authAllowedGroups: record.authAllowedGroups,
      authBypassRule: record.authBypassRule,
      egressContainer: record.egressContainer,
      egressHostPort: record.egressHostPort,
      notes: record.notes,
      // Engine-only build settings (host/schema.ts): shown and edited on the
      // Settings tab's Builds board, never part of drift.
      buildOnBox: record.buildOnBox,
      buildStrategy: record.buildStrategy,
      buildPublish: record.buildPublish,
      buildEnvPlaceholders: record.buildEnvPlaceholders,
      railpackEnv: record.railpackEnv,
      githubRepoId: record.githubRepoId,
      updatedAt: record.updatedAt.toISOString(),
      envVars: record.envVars.map((e) => ({ key: e.key, value: e.value, note: e.note })),
      // In the FRAME rather than only in the tab payload, because this is what
      // the editor EDITS: a save sends the whole list back, so it has to be the
      // authored list rather than the tab's rendering of it (which carries run
      // facts the registry knows nothing about). The contract's shape, not the
      // row's: `taskId` is the id, and the row's uuid is nobody's business
      // outside the repository.
      tasks: record.tasks.map((t) => ({
        id: t.taskId,
        schedule: t.schedule,
        command: t.command,
        timeoutSec: t.timeoutSec,
      })),
    },
  }
}
