import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'
import type { AccessWindow } from '../lib/access-window'
// Type-only, so the database module it lives next to is not pulled in here —
// every value import in this file is dynamic for exactly that reason.
import type { NewApp } from '../lib/repo/apps'
import { defaultImage, OWNER, REGISTRY_HOST_PATTERN } from '../lib/site'

// Server functions behind the Apps UI. Kept in one module so the list page,
// the detail page and the apply bar all read the same shapes.
//
// Everything here runs server-side only: the database URL, the LiteLLM key and
// the metrics endpoints must not cross to the browser, and neither must the
// ability to write an apply request.

export const fetchApps = createServerFn().handler(async () => {
  const { listApps, driftOf } = await import('../lib/repo/apps')
  const { effectiveHostname } = await import('../lib/hostname')
  const { manifestEntries } = await import('../lib/nix-manifest')
  const { appStatuses } = await import('../lib/metrics')
  const { readApplyStatus } = await import('../lib/apply')

  // Independent reads — the registry rows and the manifest file — fetched
  // together rather than one behind the other.
  const [records, entries] = await Promise.all([listApps(), manifestEntries()])
  const manifest = new Map(entries.map((m) => [m.name, m]))
  // appStatuses degrades per-app rather than rejecting, so a prometheus
  // outage costs the status column, not the page.
  const { appIcon, siteIcon } = await import('../lib/app-icon')
  const { EXTERNAL_APPS } = await import('../lib/external-apps')
  const { readWorkspaces, readWorkspaceRequestStatus, workspaceFor } = await import(
    '../lib/workspaces'
  )
  const [statuses, applyStatus, icons, externalIcons, workspaces, workspaceStatus] =
    await Promise.all([
      appStatuses(records.map((r) => r.name)),
      readApplyStatus(),
      // Resolved per app, in parallel, and cached for an hour in that module —
      // so this costs one round of probes after a restart and nothing after.
      Promise.all(
        records.map(
          async (r) =>
            (await appIcon(r.name, effectiveHostname(r.name, r.hostname), r.stage !== 'off')) !==
            null,
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
      hostname: effectiveHostname(r.name, r.hostname),
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
})

/**
 * The container registry tab.
 *
 * Its own entry point, and separate from the npm one, because each is a tab
 * that should render as soon as ITS upstream answers. Hostnames come from the
 * nix manifest rather than being derived from the service name — daedalus
 * sits on a private bridge (auth.isolated) and reaches both through traefik.
 */
export const fetchImagesTab = createServerFn().handler(async () => {
  const { loadImages } = await import('../lib/apps/registries')
  const { webAppHosts } = await import('../lib/nix-manifest')
  const hosts = await webAppHosts()
  return loadImages((app) => `https://${hosts[app] ?? app}`)
})

/** The npm registry tab. See above for why it is not folded into that one. */
export const fetchPackagesTab = createServerFn().handler(async () => {
  const { loadPackages } = await import('../lib/apps/registries')
  const { webAppHosts } = await import('../lib/nix-manifest')
  const hosts = await webAppHosts()
  return loadPackages((app) => `https://${hosts[app] ?? app}`)
})

/**
 * The app detail page's frame: the record, whether it has drifted, and the two
 * live signals the hero shows.
 *
 * Split from the per-tab payload below because the two have completely
 * different costs. This is a Postgres read, two file reads and four prometheus
 * queries — tens of milliseconds — and the page cannot render at all without
 * it, since the tab bar itself depends on whether the app has a database or an
 * egress container. The expensive part is always the tab, so the tab is what
 * streams.
 */
export const fetchApp = createServerFn()
  .inputValidator((input: { name: string }) => input)
  .handler(async ({ data }) => {
    const { name } = data
    const { getApp, driftOf } = await import('../lib/repo/apps')
    const { effectiveHostname } = await import('../lib/hostname')
    const { hostnamesTakenBy, operatorSecretApps } = await import('../lib/nix-manifest')
    const { manifestEntries } = await import('../lib/nix-manifest')
    const { appStatuses } = await import('../lib/metrics')
    const { readApplyStatus } = await import('../lib/apply')
    const { lastDeploy, pullFailing, readDeployStatus } = await import('../lib/deploy')
    const { readWorkspaces, readWorkspaceRequestStatus, workspaceFor } = await import(
      '../lib/workspaces'
    )

    const [record, entries] = await Promise.all([getApp(name), manifestEntries()])
    if (!record) return null

    const manifest = entries.find((m) => m.name === name)

    // Every app repo lives under OWNER, keyed by the app's name — the same
    // assumption the runner and the create flow make. True for the local-mode
    // entry too: daedalus's repo is the flake repo, which carries its name.
    const repo = `${OWNER}/${record.name}`

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
    ] = await Promise.all([
      appStatuses([name]),
      readApplyStatus(),
      lastDeploy(name),
      pullFailing(name),
      readDeployStatus(),
      // So the hostname field can reject a collision as it is typed rather
      // than during the rebuild it would otherwise fail.
      hostnamesTakenBy(effectiveHostname(record.name, record.hostname)),
      import('../lib/app-icon').then(
        async ({ appIcon }) =>
          (await appIcon(
            record.name,
            effectiveHostname(record.name, record.hostname),
            record.stage !== 'off',
          )) !== null,
      ),
      readWorkspaces(),
      readWorkspaceRequestStatus(),
    ])

    return {
      applyStatus,
      deployStatus,
      repo,
      workspace: workspaceFor(repo, workspaces.data),
      // From the snapshot when it has published, from the env binding before
      // the first publish — same value, different freshness.
      workspaceRoot: workspaces.data.root || (process.env.WORKSPACE_ROOT ?? ''),
      workspaceStatus,
      takenHostnames,
      // Authoritative record from the app's own deploy unit — a deploy also
      // runs from the timer and from a manual systemctl start, neither of
      // which goes through daedalus.
      lastDeploy: deploy,
      pullBroken,
      drift: driftOf(record, manifest),
      status: statuses[name] ?? null,
      app: {
        name: record.name,
        stage: record.stage,
        managedInNix: record.managedInNix,
        sourceMode: record.sourceMode,
        deployEnable: record.deployEnable,
        image: record.image,
        effectiveImage: record.image ?? defaultImage(record.name),
        hostname: record.hostname,
        effectiveHostname: effectiveHostname(record.name, record.hostname),
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
        updatedAt: record.updatedAt.toISOString(),
        envVars: record.envVars.map((e) => ({ key: e.key, value: e.value, note: e.note })),
      },
    }
  })

/**
 * Everything one tab of the app detail page needs, and nothing another one
 * does.
 *
 * The route calls this WITHOUT awaiting it, so the frame is on screen while
 * this runs and each tab body streams in behind a skeleton. That is what makes
 * the expensive tabs affordable: `overview` is nine prometheus queries,
 * `access` is ten Loki ones, `database` sixteen. None of them ever delays the
 * page, and switching tabs re-runs exactly one of them.
 *
 * Discriminated by `kind` so a tab cannot read another tab's payload — the
 * union is what stops a future edit from rendering `access` data on the logs
 * tab and getting a runtime undefined instead of a type error.
 */
export type AppTabData =
  | { kind: 'overview'; resources: AppResources; dbSize: number | null; logs1h: number | null }
  | {
      kind: 'deployments'
      ci: CiSnapshot
      activity: ActivityRow[]
      deployments: DeployRow[]
      /** Which workflow the Run CI button dispatches, and whether it can be. */
      publish: { workflow: string | null; dispatchable: boolean }
    }
  | { kind: 'access'; access: AppAccess }
  | { kind: 'secrets'; env: EnvPayload }
  | { kind: 'logs' }
  | { kind: 'database'; database: AppDatabase }
  | { kind: 'vpn'; vpn: AppVpn }
  | { kind: 'settings' }

type AppResources = Awaited<ReturnType<typeof import('../lib/metrics')['appResources']>>
type AppDatabase = Awaited<ReturnType<typeof import('../lib/metrics')['appDatabase']>>
type AppVpn = Awaited<ReturnType<typeof import('../lib/metrics')['appVpn']>>
type AppAccess = Awaited<ReturnType<typeof import('../lib/access')['appAccess']>>
type CiSnapshot = Awaited<ReturnType<typeof import('../lib/ci')['readCiSnapshot']>>
type ActivityRow = { ts: string; line: string; source: 'build' | 'deploy' }
type EnvSnapshotVar = Awaited<
  ReturnType<typeof import('../lib/env-snapshot')['readEnvSnapshot']>
>['vars'][number]
type EnvPayload = {
  available: boolean
  takenAt: string | null
  // `origin` and `group` keep their union types rather than widening to
  // string: the UI switches on them, and a widened string would let a typo
  // through to a missing label at runtime.
  vars: (Pick<EnvSnapshotVar, 'key' | 'origin' | 'group' | 'secret'> & {
    note: string | null
    value: string | null
  })[]
}
type DeployRow = {
  id: string
  digest: string
  result: string
  httpCode: string | null
  startedAt: string
  durationMs: number
  revision: string | null
  shortRevision: string | null
  commitUrl: string | null
  imageCreatedAt: string | null
  isCurrent: boolean
}

export const fetchAppTab = createServerFn()
  .inputValidator((input: { name: string; tab: string; accessWindow: AccessWindow }) => input)
  .handler(async ({ data }): Promise<AppTabData> => {
    const { name, tab, accessWindow } = data
    const { getApp } = await import('../lib/repo/apps')
    const { effectiveHostname } = await import('../lib/hostname')

    const record = await getApp(name)
    if (!record) return { kind: 'settings' }

    switch (tab) {
      case 'overview': {
        const { appResources, databaseSize, logVolume, NO_RESOURCES } = await import(
          '../lib/metrics'
        )
        const [resources, dbSize, logs1h] = await Promise.all([
          appResources(name).catch(() => NO_RESOURCES),
          record.postgres ? databaseSize(name) : Promise.resolve(null),
          logVolume(name),
        ])
        return { kind: 'overview', resources, dbSize, logs1h }
      }

      case 'deployments': {
        const { activityLog } = await import('../lib/metrics')
        const { readCiSnapshot } = await import('../lib/ci')
        const { commitUrl } = await import('../lib/registry')
        // Fold deploy.sh's journal into Postgres before reading it back. Done
        // on demand rather than on a timer: the journal is a small bounded file
        // and this is the only place the result is consumed.
        const { ingestDeployments, listDeployments } = await import('../lib/repo/deployments')
        const { repoChecks } = await import('../lib/github-repos')
        await ingestDeployments(record.id, name)
        const [deploys, ci, activity, deploy, publish] = await Promise.all([
          listDeployments(record.id),
          readCiSnapshot(name),
          activityLog(name, 60),
          (await import('../lib/deploy')).lastDeploy(name),
          // Which workflow to dispatch. Cached for a minute in that module, and
          // skipped entirely for a local-source app: there is no repo of its
          // own to run anything in.
          record.sourceMode === 'local'
            ? Promise.resolve({ publishWorkflow: null, dispatchable: false })
            : repoChecks(name).catch(() => ({ publishWorkflow: null, dispatchable: false })),
        ])
        return {
          kind: 'deployments',
          ci,
          publish: { workflow: publish.publishWorkflow, dispatchable: publish.dispatchable },
          activity: activity.map((l) => ({
            ts: l.ts.toISOString(),
            line: l.line,
            source: l.source,
          })),
          deployments: deploys.map((d) => ({
            id: d.id,
            digest: d.digest.replace('sha256:', ''),
            result: d.result,
            httpCode: d.httpCode,
            startedAt: d.startedAt.toISOString(),
            durationMs: d.durationMs,
            revision: d.revision,
            shortRevision: d.revision ? d.revision.slice(0, 8) : null,
            commitUrl: commitUrl(d.sourceUrl, d.revision),
            imageCreatedAt: d.imageCreatedAt ? d.imageCreatedAt.toISOString() : null,
            isCurrent: deploy ? d.digest === deploy.digest : false,
          })),
        }
      }

      case 'access': {
        const { appAccess, noAccess } = await import('../lib/access')
        // Gated on the app actually being published through the tunnel:
        // `stage != live` means there is no cfweb traffic to find, so the ten
        // queries would all be a round trip to confirm zero.
        const access =
          record.stage === 'live'
            ? await appAccess(effectiveHostname(record.name, record.hostname), accessWindow).catch(
                () => noAccess(accessWindow),
              )
            : noAccess(accessWindow)
        return { kind: 'access', access }
      }

      case 'secrets': {
        // Secret VALUES are deliberately NOT in this payload. Loader data is
        // serialised into the HTML, so shipping them and masking with CSS
        // would put every database password in view-source — theatre, not
        // concealment. The reveal button fetches one value at a time.
        const { readEnvSnapshot } = await import('../lib/env-snapshot')
        const { operatorSecretApps } = await import('../lib/nix-manifest')
        const declared = new Map(record.envVars.map((e) => [e.key, e.note]))
        const snapshot = await readEnvSnapshot(
          name,
          declared,
          (await operatorSecretApps()).includes(name),
        )
        return {
          kind: 'secrets',
          env: {
            available: snapshot.available,
            takenAt: snapshot.takenAt,
            vars: snapshot.vars.map((v) => ({
              key: v.key,
              origin: v.origin,
              group: v.group,
              secret: v.secret,
              note: v.note ?? null,
              value: v.secret ? null : v.value,
            })),
          },
        }
      }

      // Nothing to fetch: the tab frames a Grafana panel that queries Loki
      // itself, so pulling sixty lines through here would be a round trip
      // whose result is serialised into the page and never rendered.
      case 'logs':
        return { kind: 'logs' }

      case 'database': {
        const { appDatabase, NO_DATABASE } = await import('../lib/metrics')
        // Gated on the app actually having a database: without it every app
        // without postgres would pay for sixteen round trips to be told that
        // `pg_database_size_bytes{datname="…"}` matches nothing.
        return {
          kind: 'database',
          database: record.postgres
            ? await appDatabase(name).catch(() => NO_DATABASE)
            : NO_DATABASE,
        }
      }

      case 'vpn': {
        const { appVpn, NO_VPN } = await import('../lib/metrics')
        return {
          kind: 'vpn',
          vpn:
            record.egressContainer === null
              ? NO_VPN
              : await appVpn(record.egressContainer).catch(() => NO_VPN),
        }
      }

      default:
        // Settings edits the record the frame already carries — there is
        // nothing further to fetch, and no request is made.
        return { kind: 'settings' }
    }
  })

/**
 * What the create form needs before it can ask anything: the repositories to
 * pick from, and the names already spoken for.
 *
 * The repo list is the slow half (a GitHub round trip) and the taken names are
 * two file reads plus a query, but they are fetched together — the form cannot
 * usefully render half of itself, since picking a repo is what every later
 * step keys off.
 */
export const fetchNewAppOptions = createServerFn().handler(async () => {
  const { listRepos, OWNER } = await import('../lib/github-repos')
  const { listApps } = await import('../lib/repo/apps')
  const { manifestEntries } = await import('../lib/nix-manifest')

  const [repos, records, manifest] = await Promise.all([listRepos(), listApps(), manifestEntries()])

  // A name is taken if EITHER source knows it: the database holds what
  // daedalus manages, the manifest additionally holds the hand-written
  // entries. The picker greys those repos out rather than letting the create
  // fail at the last step.
  const taken = [...new Set([...records.map((r) => r.name), ...manifest.map((m) => m.name)])]

  return { owner: OWNER, taken, ...repos }
})

/**
 * The repository listing again, past its cache.
 *
 * Only the listing: the taken names come from files this box owns and are
 * cheap, but they also cannot change while somebody is filling this form in.
 * Returned to the caller rather than invalidating the route — re-running the
 * loader would remount the wizard and take the half-filled form with it.
 */
export const refreshRepoList = createServerFn().handler(async () => {
  const { listRepos, forgetRepos } = await import('../lib/github-repos')
  forgetRepos()
  return listRepos()
})

/**
 * Everything that has to be true before this repo can become an app.
 *
 * Two of the answers come from GitHub (workflows, repo secret) and one from
 * the box's own registry (has CI ever published an image?). The last one is
 * the only hard gate: a declaration whose image does not exist produces a
 * container that cannot start, on a timer, until somebody notices.
 */
export const fetchAppPreflight = createServerFn()
  .inputValidator((i: { repo: string; name: string; image: string | null; force?: boolean }) => i)
  .handler(async ({ data }) => {
    const { forgetRepoChecks, repoChecks } = await import('../lib/github-repos')
    const { imageInfo } = await import('../lib/registry')

    // The GitHub half of this is memoized for a minute, so a re-check that
    // does not drop the entry first is not a re-check at all — it re-reads the
    // registry and re-serves the same cached answer about the repo. Only the
    // explicit refresh forces it; the debounced re-runs behind every keystroke
    // must NOT, or the cache would exist in name only.
    if (data.force === true) forgetRepoChecks(data.repo)

    const effectiveImage = data.image?.trim() || defaultImage(data.name)

    // Only images on the box's own zot can be verified from here — an override
    // pointing at GHCR or docker.io is reported as unverified rather than
    // guessed at, because a wrong "missing" would block a legitimate fork.
    // `<repo>` then an optional `:tag` or `@digest`; the leading separator is
    // dropped either way, since the manifest endpoint takes both as a bare
    // reference.
    const local = new RegExp(`^${REGISTRY_HOST_PATTERN}/(?<repo>[^:@]+)(?<ref>[:@].+)?$`).exec(
      effectiveImage,
    )
    const imageState =
      local?.groups?.repo === undefined
        ? ('unverifiable' as const)
        : await imageInfo(local.groups.repo, (local.groups.ref ?? ':latest').slice(1)).then(
            (info) => (info.digest === null ? ('missing' as const) : ('present' as const)),
          )

    const { checks, workflows, publishWorkflow, dispatchable } = await repoChecks(data.repo)

    return { effectiveImage, imageState, checks, workflows, publishWorkflow, dispatchable }
  })

/**
 * Authorise a repo to push to the registry: the host sets REGISTRY_PASSWORD in
 * its Actions secrets.
 *
 * The password is not in this request and not in this container — the host
 * reads it from /run/secrets. What crosses the boundary is a repo name.
 */
export const setRegistrySecretFn = createServerFn({ method: 'POST' })
  .inputValidator((i: { repo: string }) => i)
  .handler(async ({ data }) => {
    const { requestCi } = await import('../lib/ci-request')
    const { forgetRepoChecks } = await import('../lib/github-repos')
    const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'
    const id = await requestCi({ action: 'set-secret', repo: data.repo, actor })
    // The next preflight has to see the new answer rather than the cached one.
    forgetRepoChecks(data.repo)
    return { id }
  })

/**
 * Run the repo's publishing workflow now.
 *
 * For an app this is "build and publish from the UI" — the same run a push to
 * main would trigger, on the same runner, so the logs land in the CI panel on
 * its deployments tab. For a repo that is not an app yet it is the only way to
 * get a first image at all, and the host starts a one-shot runner to serve it
 * (stacks/gha-runner's bootstrap unit).
 */
export const runCiFn = createServerFn({ method: 'POST' })
  .inputValidator((i: { repo: string; workflow: string }) => i)
  .handler(async ({ data }) => {
    const { requestCi } = await import('../lib/ci-request')
    const { forgetRepoChecks } = await import('../lib/github-repos')
    const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'
    const id = await requestCi({
      action: 'run-ci',
      repo: data.repo,
      workflow: data.workflow,
      actor,
    })
    forgetRepoChecks(data.repo)
    return { id }
  })

export const fetchCiRequestStatus = createServerFn().handler(async () => {
  const { readCiRequestStatus } = await import('../lib/ci-request')
  return readCiRequestStatus()
})

export const createAppFn = createServerFn({ method: 'POST' })
  .inputValidator((i: { app: NewApp }) => i)
  .handler(async ({ data }) => {
    const { createApp, validateNewApp } = await import('../lib/repo/apps')
    return createApp(validateNewApp(data.app as unknown as Record<string, unknown>))
  })

export const deleteAppFn = createServerFn({ method: 'POST' })
  .inputValidator((i: { name: string }) => i)
  .handler(async ({ data }) => {
    const { deleteApp } = await import('../lib/repo/apps')
    await deleteApp(data.name)
    return { ok: true }
  })

export const saveApp = createServerFn({ method: 'POST' })
  .inputValidator((input: { name: string; patch: Record<string, unknown> }) => {
    // The type annotation describes the request; it does not check it. These
    // two lines are the actual boundary — the field values are checked in
    // validateAppPatch below, where the field list lives.
    if (typeof input.name !== 'string') throw new Error('name must be a string')
    if (typeof input.patch !== 'object' || input.patch === null) {
      throw new Error('patch must be an object')
    }
    return input
  })
  .handler(async ({ data }) => {
    const { updateApp, validateAppPatch } = await import('../lib/repo/apps')
    await updateApp(data.name, validateAppPatch(data.patch))
    return { ok: true }
  })

/**
 * Publish an apply request — an adapter over lib/apply-flow.ts, which owns
 * the whole check-and-write. The only thing decided here is the actor:
 * whoever passed the Pocket ID gate. The forward-auth middleware forwards
 * the claim as a header (auth.headers in stacks/daedalus/daedalus.nix), so
 * the commit records a person rather than "daedalus".
 */
export const applyRegistry = createServerFn({ method: 'POST' }).handler(async () => {
  const { runApply } = await import('../lib/apply-flow')
  const outcome = await runApply(getRequestHeader('x-forwarded-email') ?? 'unknown operator')
  return outcome.ok
    ? { ok: true as const, id: outcome.id, changed: outcome.changed }
    : { ok: false as const, reason: outcome.reason }
})

export const fetchApplyStatus = createServerFn().handler(async () => {
  const { readApplyStatus } = await import('../lib/apply')
  return readApplyStatus()
})

/**
 * Ask the host to run this app's deploy unit now, instead of waiting up to
 * two minutes for its timer. Same unit either way — this only removes latency.
 */
export const triggerDeploy = createServerFn({ method: 'POST' })
  .inputValidator((name: string) => name)
  .handler(async ({ data: name }) => {
    const { requestDeploy } = await import('../lib/deploy')
    const { getApp } = await import('../lib/repo/apps')

    const record = await getApp(name)
    if (!record) throw new Error(`no app named ${name}`)
    if (record.sourceMode === 'local') {
      throw new Error(`${name} builds from source in the flake repo — there is no image to pull`)
    }

    const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'
    return { id: await requestDeploy({ app: name, reason: 'manual redeploy', actor }) }
  })

/**
 * One secret value, on demand.
 *
 * Separate from fetchApp so secrets never enter the page payload: revealing is
 * an explicit request for a named variable, not a CSS class over data that was
 * already shipped. Behind the Pocket ID gate like the rest of the app.
 */
export const revealEnvVar = createServerFn({ method: 'POST' })
  .inputValidator((i: { name: string; key: string }) => i)
  .handler(async ({ data }) => {
    const { readEnvSnapshot } = await import('../lib/env-snapshot')
    const { getApp } = await import('../lib/repo/apps')

    // Confirms the app is one this instance manages, so the app name cannot be
    // used to read an arbitrary path out of the snapshot directory.
    const record = await getApp(data.name)
    if (!record) throw new Error(`no app named ${data.name}`)

    const snapshot = await readEnvSnapshot(data.name, new Map())
    const found = snapshot.vars.find((v) => v.key === data.key)
    if (!found) throw new Error(`no variable ${data.key} in ${data.name}`)

    // Only masked variables have anything to reveal: a non-secret value is
    // already in the page payload, so a request for one is not the UI — keep
    // this door exactly as narrow as its purpose.
    if (!found.secret) throw new Error(`${data.key} is not a masked variable`)

    return { value: found.value }
  })

export const fetchDeployStatus = createServerFn().handler(async () => {
  const { readDeployStatus } = await import('../lib/deploy')
  return readDeployStatus()
})

/**
 * Ask the host to clone a project's repo into the workspace root — or, when
 * the workspace already exists, to pull it. What crosses the bridge is a
 * repo slug; the clone happens host-side over the operator's SSH identity,
 * which never enters this container (lib/workspaces.ts).
 *
 * The allowlist is exactly the repos this UI offers a button for: the
 * registry apps (keyed OWNER/<name>) and the off-box projects' hand-declared
 * slugs. The host re-validates the slug's shape; this check is what keeps
 * the bridge from being a general "clone anything as the operator" door.
 */
export const cloneWorkspaceFn = createServerFn({ method: 'POST' })
  .inputValidator((i: { repo: string }) => i)
  .handler(async ({ data }) => {
    const { requestWorkspaceClone } = await import('../lib/workspaces')
    const { listApps } = await import('../lib/repo/apps')
    const { EXTERNAL_APPS } = await import('../lib/external-apps')

    const apps = await listApps()
    const offered = new Set([
      ...apps.map((a) => `${OWNER}/${a.name}`.toLowerCase()),
      ...EXTERNAL_APPS.flatMap((e) => (e.repo === null ? [] : [e.repo.toLowerCase()])),
    ])
    if (!offered.has(data.repo.toLowerCase())) {
      throw new Error(`${data.repo} is not one of this box's project repos`)
    }

    const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'
    return { id: await requestWorkspaceClone({ repo: data.repo, actor }) }
  })

export const fetchWorkspaceRequestStatus = createServerFn().handler(async () => {
  const { readWorkspaceRequestStatus } = await import('../lib/workspaces')
  return readWorkspaceRequestStatus()
})
