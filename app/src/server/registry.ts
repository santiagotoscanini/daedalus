import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'

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

  const records = await listApps()
  const manifest = new Map((await manifestEntries()).map((m) => [m.name, m]))
  // appStatuses degrades per-app rather than rejecting, so a prometheus
  // outage costs the status column, not the page.
  const [statuses, applyStatus] = await Promise.all([
    appStatuses(records.map((r) => r.name)),
    readApplyStatus(),
  ])

  return {
    applyStatus,
    apps: records.map((r) => ({
      name: r.name,
      stage: r.stage,
      managedInNix: r.managedInNix,
      sourceMode: r.sourceMode,
      description: r.homepageDescription,
      icon: r.homepageIcon,
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

export const fetchApp = createServerFn()
  .inputValidator(
    (input: {
      name: string
      withLogs: boolean
      withDeploys: boolean
      withEnv: boolean
      withResources: boolean
    }) => input,
  )
  .handler(async ({ data: { name, withLogs, withDeploys, withEnv, withResources } }) => {
    const { getApp, driftOf } = await import('../lib/repo/apps')
    const { effectiveHostname } = await import('../lib/hostname')
    const { hostnamesTakenBy } = await import('../lib/nix-manifest')
    const { manifestEntries } = await import('../lib/nix-manifest')
    const { appStatuses, appResources, databaseSize, recentLogs, logVolume, NO_RESOURCES } =
      await import('../lib/metrics')
    const { readApplyStatus } = await import('../lib/apply')
    const { lastDeploy, pullFailing, readDeployStatus } = await import('../lib/deploy')

    const record = await getApp(name)
    if (!record) return null

    const manifest = (await manifestEntries()).find((m) => m.name === name)

    // Fold deploy.sh's journal into Postgres before reading it back. Done on
    // demand rather than on a timer: the journal is a small bounded file and
    // this is the only place the result is consumed.
    const { ingestDeployments, listDeployments } = await import('../lib/repo/deployments')
    const { commitUrl } = await import('../lib/registry')
    let deploys: Awaited<ReturnType<typeof listDeployments>> = []
    if (withDeploys) {
      await ingestDeployments(record.id, name)
      deploys = await listDeployments(record.id)
    }

    const [
      statuses,
      resources,
      dbSize,
      logs,
      logs1h,
      applyStatus,
      deploy,
      pullBroken,
      deployStatus,
    ] =
      await Promise.all([
        appStatuses([name]),
        // Nine prometheus queries; only the overview renders them. Same
        // reasoning as the logs gate below — loader data is serialised into
        // the HTML, so paying for it on the settings tab is pure waste.
        withResources ? appResources(name).catch(() => NO_RESOURCES) : (
          Promise.resolve(NO_RESOURCES)
        ),
        record.postgres ? databaseSize(name) : Promise.resolve(null),
        // Only on the logs tab. Loader data is serialised into the HTML for
        // hydration, so fetching 60 lines unconditionally doubled the weight
        // of every other tab with text nobody was looking at.
        withLogs ? recentLogs(name, 60) : Promise.resolve([]),
        logVolume(name),
        readApplyStatus(),
        lastDeploy(name),
        pullFailing(name),
        readDeployStatus(),
      ])

    // Secret VALUES are deliberately NOT in this payload. Loader data is
    // serialised into the HTML, so shipping them and masking with CSS would
    // put every database password in view-source — theatre, not concealment.
    // The reveal button fetches one value at a time (revealEnvVar below).
    const { readEnvSnapshot } = await import('../lib/env-snapshot')
    const declared = new Map(record.envVars.map((e) => [e.key, e.note]))
    const envSnapshot = withEnv
      ? await readEnvSnapshot(name, declared)
      : { vars: [], takenAt: null, available: false }

    return {
      applyStatus,
      deployStatus,
      resources,
      // So the hostname field can reject a collision as it is typed rather
      // than during the rebuild it would otherwise fail.
      takenHostnames: await hostnamesTakenBy(effectiveHostname(record.name, record.hostname)),
      env: {
        available: envSnapshot.available,
        takenAt: envSnapshot.takenAt,
        vars: envSnapshot.vars.map((v) => ({
          key: v.key,
          origin: v.origin,
          secret: v.secret,
          note: v.note ?? null,
          value: v.secret ? null : v.value,
        })),
      },
      // Authoritative record from the app's own deploy unit — a deploy also
      // runs from the timer and from a manual systemctl start, neither of
      // which goes through daedalus.
      lastDeploy: deploy,
      pullBroken,
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
      drift: driftOf(record, manifest),
      status: statuses[name] ?? null,
      dbSize,
      logs1h,
      logs: logs.map((l) => ({ ts: l.ts.toISOString(), level: l.level, line: l.line })),
      app: {
        name: record.name,
        stage: record.stage,
        managedInNix: record.managedInNix,
        sourceMode: record.sourceMode,
        image: record.image,
        effectiveImage: record.image ?? `registry.toscanini.me/${record.name}:latest`,
        hostname: record.hostname,
        effectiveHostname: effectiveHostname(record.name, record.hostname),
        description: record.homepageDescription,
        icon: record.homepageIcon,
        postgres: record.postgres,
        storage: record.storage,
        litellm: record.litellm,
        prometheus: record.prometheus,
        operatorSecrets: record.operatorSecrets,
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

export const saveApp = createServerFn({ method: 'POST' })
  .inputValidator((input: { name: string; patch: Record<string, unknown> }) => input)
  .handler(async ({ data }) => {
    const { updateApp } = await import('../lib/repo/apps')
    await updateApp(data.name, data.patch)
    return { ok: true }
  })

export const saveEnvVar = createServerFn({ method: 'POST' })
  .inputValidator((i: { name: string; key: string; value: string; note: string | null }) => i)
  .handler(async ({ data }) => {
    const { setEnvVar } = await import('../lib/repo/apps')
    await setEnvVar(data.name, data.key, data.value, data.note)
    return { ok: true }
  })

export const removeEnvVar = createServerFn({ method: 'POST' })
  .inputValidator((i: { name: string; key: string }) => i)
  .handler(async ({ data }) => {
    const { deleteEnvVar } = await import('../lib/repo/apps')
    await deleteEnvVar(data.name, data.key)
    return { ok: true }
  })

/**
 * Publish an apply request: export the whole registry, describe what moved,
 * drop it in the bind mount for the host agent.
 *
 * The whole registry every time, not a diff — the export IS the desired state,
 * and shipping a patch would make the committed file depend on what the last
 * apply happened to contain.
 */
export const applyRegistry = createServerFn({ method: 'POST' }).handler(async () => {
  const { listApps, toRegistryExport, driftOf } = await import('../lib/repo/apps')
  const { manifestEntries } = await import('../lib/nix-manifest')
  const { requestApply, summarise, readApplyStatus } = await import('../lib/apply')
  const { renderRegistryFile } = await import('../lib/registry-file')

  // Refuse while one is in flight. The host script holds fleet.rebuildLock, so
  // a second apply could not corrupt anything — it would simply queue behind
  // it and then write a registry snapshot taken BEFORE the first one landed.
  // Rejecting here is both faster feedback and the correct answer.
  const inFlight = await readApplyStatus()
  if (inFlight.state === 'running') {
    return { ok: false as const, reason: `an apply is already running (${inFlight.phase})` }
  }

  const records = await listApps()
  const manifest = new Map((await manifestEntries()).map((m) => [m.name, m]))

  const changed = records
    .filter((r) => !r.managedInNix)
    .map((r) => ({ name: r.name, fields: driftOf(r, manifest.get(r.name)) }))
    .filter((c) => c.fields.length > 0)

  if (changed.length === 0) {
    return { ok: false as const, reason: 'nothing to apply' }
  }

  // Whoever passed the Pocket ID gate. The forward-auth middleware forwards
  // the claim as a header (auth.headers in stacks/daedalus/daedalus.nix), so
  // the commit records a person rather than "daedalus".
  const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'

  const id = await requestApply({
    // The finished file, not a data structure: the host agent copies these
    // bytes into the flake verbatim and never parses the registry.
    fileBody: renderRegistryFile(toRegistryExport(records)),
    summary: summarise(changed),
    actor,
  })

  return { ok: true as const, id, changed }
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

    return { value: found.value }
  })

export const fetchDeployStatus = createServerFn().handler(async () => {
  const { readDeployStatus } = await import('../lib/deploy')
  return readDeployStatus()
})
