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
      hostname: `${r.name}.toscanini.me`,
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
  .inputValidator((name: string) => name)
  .handler(async ({ data: name }) => {
    const { getApp, driftOf } = await import('../lib/repo/apps')
    const { manifestEntries } = await import('../lib/nix-manifest')
    const { appStatuses, databaseSize, recentLogs, logVolume } = await import('../lib/metrics')
    const { readApplyStatus } = await import('../lib/apply')

    const record = await getApp(name)
    if (!record) return null

    const manifest = (await manifestEntries()).find((m) => m.name === name)

    const [statuses, dbSize, logs, logs1h, applyStatus] = await Promise.all([
      appStatuses([name]),
      record.postgres ? databaseSize(name) : Promise.resolve(null),
      recentLogs(name, 60),
      logVolume(name),
      readApplyStatus(),
    ])

    return {
      applyStatus,
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
        description: record.homepageDescription,
        icon: record.homepageIcon,
        postgres: record.postgres,
        storage: record.storage,
        litellm: record.litellm,
        prometheus: record.prometheus,
        operatorSecrets: record.operatorSecrets,
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
  const { requestApply, summarise } = await import('../lib/apply')
  const { renderRegistryFile } = await import('../lib/registry-file')

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
