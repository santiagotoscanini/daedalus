import type { Ctx } from '../../core/ctx'
import { readApplyStatus } from '../../host/apply'
import { type ManifestEntry, manifestEntries } from '../../host/nix-manifest'
import { readRegisterStatus, startRegister } from '../../host/register'
import { isAwaitingEntry, readCommittedRegistry } from '../../host/site-registry'
import { renderRegistryFile } from '../registry-file'
import { type AppRecord, getApp, listApps, markFirstImage } from '../repo/apps'
import type { Result } from '../result'
import type { SetupProgress, SetupStep } from '../setup-progress'
import { firstImage, gatedReference } from './image-gate'
import { SET_UP, toRegistryExport } from './manifest-map'

// A new app, from its create to its running container, in one rebuild.
//
//   create        the row, `awaitingImage` (lib/repo/apps.ts createApp)
//   register      apps.json gets the entry with the marker, committed with no
//                 rebuild (the `register` root verb); nix makes nothing for it
//   build         its first build: the builder authorizes the app from that
//                 committed file at run time (nix host/build.sh)
//   marker        once the image exists, the row's marker is cleared
//   Apply         ONE rebuild creates everything — database, secrets, OIDC
//                 client, container, route, DNS, probe, deploy timer — and its
//                 activation starts the container on the image just pushed
//
// The build of an app that awaits its image starts no deploy (it has no
// deploy unit yet), so the Apply's activation is the one start and nothing
// races it. `settleNewApps` runs on every scheduler tick and moves each app
// one step; the create form and Retry only start a step sooner.

const ACTOR = 'daedalus'

const g = globalThis as unknown as Record<string, unknown>

// ── register ────────────────────────────────────────────────────────────────

// What this process last asked a register to write: a failed register is not
// retried with the same file on every tick (Retry on the app's page does), and
// a different file — another app created since — is. On globalThis, like the
// scheduler's own state, so a re-evaluated module keeps it.
const REGISTER_SLOT = 'daedalusRegisterTextV1'

/**
 * apps.json as a register would write it: the committed file's entries kept
 * byte for byte, but for the ones awaiting their image, which become exactly
 * the awaiting rows — plus an awaiting entry whose row has since been cleared,
 * left for the Apply that sets that app up. The host refuses any other change.
 * Null when there is no committed file to start from.
 */
async function registerFile(records: AppRecord[]) {
  const committed = await readCommittedRegistry()
  if (committed === null) return null
  const byName = new Map(records.map((r) => [r.name, r]))
  const kept = Object.entries(committed.apps).filter(([name, entry]) => {
    if (!isAwaitingEntry(entry)) return true
    const r = byName.get(name)
    return r !== undefined && !r.awaitingImage
  })
  const awaiting = toRegistryExport(records.filter((r) => r.awaitingImage && !r.managedInNix)).apps
  const apps = Object.fromEntries(
    [...kept, ...Object.entries(awaiting)].sort(([a], [b]) => a.localeCompare(b)),
  )
  const text = renderRegistryFile({
    schemaVersion: committed.schemaVersion as number,
    apps: apps as Parameters<typeof renderRegistryFile>[0]['apps'],
  })
  const before = Object.keys(committed.apps).filter((n) => isAwaitingEntry(committed.apps[n]))
  const after = Object.keys(apps).filter((n) => isAwaitingEntry(apps[n]))
  return {
    text,
    changed: text !== committed.text,
    added: after.filter((n) => !before.includes(n)),
    removed: before.filter((n) => !after.includes(n)),
  }
}

/** Commit the awaiting entries the rows say there should be. Ok with null when nothing moved. */
export async function registerAwaiting(
  ctx: Pick<Ctx, 'controller'>,
  actor: string,
): Promise<Result<string | null>> {
  const file = await registerFile(await listApps())
  if (file === null) return { ok: false, reason: 'site/apps.json is missing or unreadable.' }
  if (!file.changed) return { ok: true, value: null }
  const words = [
    ...file.added.map((n) => `${n}: new`),
    ...file.removed.map((n) => `${n}: removed before its first image`),
  ]
  const { commitSwitch } = await import('../../host/apply-flow')
  g[REGISTER_SLOT] = file.text
  const started = await startRegister(ctx, {
    appsJson: file.text,
    summary: words.join(', ') || 'awaiting entries',
    actor,
    commit: await commitSwitch(),
  })
  return started.ok ? { ok: true, value: started.id } : { ok: false, reason: started.reason }
}

// ── the tick ────────────────────────────────────────────────────────────────

/**
 * The setup Apply this process started last, so a failed one is not retried on
 * every tick for the same apps: Retry on the app's page starts it again, and an
 * app that became ready since is reason enough to try once more.
 */
const SLOT = 'daedalusSetupApplyV1'
const lastSetupApply = (): { id: string; apps: string[] } | null =>
  (g[SLOT] as { id: string; apps: string[] } | undefined) ?? null

const settled = (m: ManifestEntry | undefined): boolean =>
  m !== undefined && m.awaitingImage !== true

/** One step for every new app: register it, clear its marker, set it up. */
export async function settleNewApps(ctx: Ctx): Promise<void> {
  const records = (await listApps()).filter((r) => !r.managedInNix)
  const manifest = new Map((await manifestEntries()).map((m) => [m.name, m]))

  // Registered: unless a register is running, or the last one failed with this
  // same file, which the page shows with a Retry rather than a loop.
  const register = await readRegisterStatus(ctx)
  if (register.state !== 'running') {
    const file = await registerFile(records)
    const failedSame = register.state === 'failed' && g[REGISTER_SLOT] === file?.text
    if (file?.changed && !failedSame) await registerAwaiting(ctx, ACTOR)
  }

  // The marker, once the image exists: asked of the registry only for an app
  // with a published build, or one whose image the box does not build.
  for (const r of records.filter((x) => x.awaitingImage)) {
    if (gatedReference(ctx.site, r) !== null && (await lastLiveBuild(r))?.state !== 'succeeded') {
      continue
    }
    const image = await firstImage(ctx.site, r)
    if (image === 'present' || image === 'unchecked') {
      if (await markFirstImage(r.name)) console.info(`[setup] ${r.name}: first image published`)
    }
  }

  // The Apply: only when setting new apps up is all it would carry, and not
  // again after one this process started failed.
  const owed = (await listApps()).filter(
    (r) => !r.managedInNix && !r.awaitingImage && !settled(manifest.get(r.name)),
  )
  if (owed.length === 0) return
  const apply = await readApplyStatus(ctx)
  if (apply.state === 'running') return
  const last = lastSetupApply()
  const names = owed.map((r) => r.name)
  const tried = last !== null && apply.id === last.id && apply.state === 'failed'
  if (tried && names.every((n) => last.apps.includes(n))) return
  await startSetupApply(ctx, names)
}

/** Run the Apply that sets these apps up, when it would carry nothing else. */
async function startSetupApply(ctx: Ctx, names: string[]): Promise<Result<string>> {
  const { currentChanges, runApply } = await import('../../host/apply-flow')
  const { changed } = await currentChanges()
  const other = changed.filter(
    (c) => !names.includes(c.name) || c.fields.length !== 1 || c.fields[0] !== SET_UP,
  )
  if (other.length > 0) {
    return {
      ok: false,
      reason: `Other changes are pending (${other.map((c) => c.name).join(', ')}): the Apply bar sets this app up with them.`,
    }
  }
  const outcome = await runApply(ctx, ACTOR)
  if (!outcome.ok) return { ok: false, reason: outcome.reason }
  g[SLOT] = { id: outcome.id, apps: names }
  console.info(`[setup] ${names.join(', ')}: Apply ${outcome.id} started`)
  return { ok: true, value: outcome.id }
}

async function lastLiveBuild(r: { id: string }) {
  const { listBuilds, toBuildRow } = await import('../repo/builds')
  return (await listBuilds(r.id, 10))
    .map(toBuildRow)
    .find((b) => b.lane === 'main' && b.publish === 'live')
}

// ── the page ────────────────────────────────────────────────────────────────

const progress = (step: SetupStep, rest: Partial<Omit<SetupProgress, 'step'>> = {}) => ({
  step,
  failed: null,
  note: null,
  buildId: null,
  ...rest,
})

/**
 * Where a new app is on its way to running; null for an app that is running,
 * or one that is not new (it has been set up and its container was up once).
 */
export async function setupProgress(
  ctx: Pick<Ctx, 'controller'>,
  record: AppRecord,
  manifest: ManifestEntry | undefined,
  live: { containerUp: boolean; deployedOnce: boolean },
): Promise<SetupProgress | null> {
  if (record.managedInNix) return null
  if (record.awaitingImage) {
    const committed = await readCommittedRegistry()
    if (!isAwaitingEntry(committed?.apps[record.name])) {
      const reg = await readRegisterStatus(ctx)
      return reg.state === 'failed'
        ? progress('setting up', { failed: { what: 'register', detail: reg.error } })
        : progress('setting up')
    }
    const build = await lastLiveBuild(record)
    if (build === undefined) {
      return progress('building', {
        failed: record.buildOnBox
          ? { what: 'build', detail: 'No build has been queued yet.' }
          : null,
        note: record.buildOnBox ? null : 'Box builds are off: its image comes from elsewhere.',
      })
    }
    if (build.state === 'succeeded') return progress('starting', { buildId: build.id })
    if (build.state === 'failed' || build.state === 'cancelled') {
      return progress('building', {
        buildId: build.id,
        failed: { what: 'build', detail: build.error ?? `The build ${build.state}.` },
      })
    }
    return progress('building', { buildId: build.id })
  }
  if (!settled(manifest)) {
    const apply = await readApplyStatus(ctx)
    const last = lastSetupApply()
    if (apply.state === 'failed' && last?.id === apply.id && last.apps.includes(record.name)) {
      return progress('starting', { failed: { what: 'apply', detail: apply.error } })
    }
    return progress('starting', {
      note: apply.state === 'running' ? null : 'Waiting for an Apply to create it.',
    })
  }
  if (!live.containerUp && !live.deployedOnce) return progress('starting')
  return null
}

/** The page's Retry: the step that failed, again. */
export async function retrySetup(ctx: Ctx, name: string, actor: string): Promise<Result<null>> {
  const record = await getApp(name)
  if (!record) return { ok: false, reason: `No app named ${name}.` }
  const manifest = (await manifestEntries()).find((m) => m.name === name)
  const at = await setupProgress(ctx, record, manifest, { containerUp: false, deployedOnce: true })
  switch (at?.failed?.what) {
    case 'register': {
      const r = await registerAwaiting(ctx, actor)
      return r.ok ? { ok: true, value: null } : r
    }
    case 'build': {
      const { buildNow } = await import('../../core/builds/actions')
      const r = await buildNow({ app: name, actor })
      return r.ok ? { ok: true, value: null } : r
    }
    case 'apply': {
      delete g[SLOT]
      const r = await startSetupApply(ctx, [name])
      return r.ok ? { ok: true, value: null } : r
    }
    default:
      return { ok: false, reason: `${name} has nothing to retry.` }
  }
}
