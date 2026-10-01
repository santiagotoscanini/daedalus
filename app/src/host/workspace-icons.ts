import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { isRecord } from '../lib/is-record'
import type { ResolvedIcon } from './app-icon'
import { env } from './env'
import type { Workspace } from './workspaces'

// Each workspace's app icon, handed to the session host (session-host/,
// `workspaces.icon`), which serves it to santree. santree reaches the box
// only through the session host, never this app over HTTP, and the icons are
// not stored anywhere: they are resolved from each app at runtime
// (host/app-icon.ts). So the app writes what it resolved to
// `<apply dir>/workspace-icons/<workspace>.icon` — the Apps list's own icon,
// through the same cache — and the session host reads the file. Each process
// writes only its own directory: this one is under the app's apply dir, and
// the session host (the operator, like this container's root) only reads it.
//
// A workspace gets an icon when its remote is a project the Apps page shows:
// a registry app (`<owner>/<name>`) or an off-box project with a repo. One
// file per workspace, the raw bytes; the session host sniffs the type again
// and refuses anything else. Written only when the bytes change, removed when
// the workspace or its icon is gone. A run that cannot read the workspaces
// snapshot or the registry changes nothing.

/** The types santree renders; anything else is left out. */
export const ICON_TYPES: ReadonlySet<string> = new Set([
  'image/png',
  'image/svg+xml',
  'image/x-icon',
  'image/webp',
])

/** The largest icon handed over; the session host refuses a bigger file too. */
export const MAX_ICON_BYTES = 64 * 1024

const SUFFIX = '.icon'
const TMP = '.tmp'

const iconDir = (): string => join(env.get('APPLY_DIR') ?? '/apply', 'workspace-icons')

/** One plain path component, as the session host's `workspaces.list` holds them. */
function plainName(name: string): boolean {
  return !(
    name === '' ||
    name === '.' ||
    name === '..' ||
    name.startsWith('-') ||
    name.includes('/') ||
    name.includes('\0')
  )
}

/** Whether santree may be handed these bytes. */
export function servable(icon: ResolvedIcon): boolean {
  return (
    ICON_TYPES.has(icon.contentType) && icon.body.length > 0 && icon.body.length <= MAX_ICON_BYTES
  )
}

/**
 * Which project's icon each workspace shows: its remote matched,
 * case-insensitively, against the projects' repos. Keys are workspace names
 * (plain components only); values are the project keys handed in.
 */
export function iconPlan(
  workspaces: readonly Pick<Workspace, 'name' | 'remote'>[],
  projects: readonly { repo: string; key: string }[],
): Map<string, string> {
  const byRepo = new Map(projects.map((p) => [p.repo.toLowerCase(), p.key]))
  const out = new Map<string, string>()
  for (const w of workspaces) {
    if (w.remote === null || !plainName(w.name)) continue
    const key = byRepo.get(w.remote.toLowerCase())
    if (key !== undefined) out.set(w.name, key)
  }
  return out
}

/**
 * Make `dir` hold exactly `icons` (workspace name → bytes): each written
 * atomically when its bytes differ, every other `.icon` file (and a temp
 * left by a crash) removed. Icons santree may not be handed are left out.
 */
export async function writeIcons(
  icons: ReadonlyMap<string, ResolvedIcon>,
  dir: string = iconDir(),
): Promise<{ written: string[]; removed: string[] }> {
  await mkdir(dir, { recursive: true })
  const written: string[] = []
  const keep = new Set<string>()
  for (const [name, icon] of icons) {
    if (!plainName(name) || !servable(icon)) continue
    const file = name + SUFFIX
    keep.add(file)
    const path = join(dir, file)
    const held = await readFile(path).catch(() => null)
    if (held?.equals(icon.body)) continue
    await writeFile(path + TMP, icon.body, { mode: 0o644 })
    await rename(path + TMP, path)
    written.push(name)
  }
  const removed: string[] = []
  for (const file of await readdir(dir)) {
    const stale = file.endsWith(SUFFIX) ? !keep.has(file) : file.endsWith(SUFFIX + TMP)
    if (!stale) continue
    await rm(join(dir, file), { force: true })
    if (file.endsWith(SUFFIX)) removed.push(file.slice(0, -SUFFIX.length))
  }
  return { written, removed }
}

/** One export: the workspaces, the projects, their icons, the files. */
async function exportOnce(): Promise<void> {
  // Dynamic, like gateway-sync's: the database and the registry load only
  // when a run does, never with the pure half above.
  const [
    { readWorkspaces },
    { listApps },
    { listExternalApps },
    { makeCtx },
    { appIcon, siteIcon },
    { effectiveHostname },
    { stageExposed },
    { appRepo },
  ] = await Promise.all([
    import('./workspaces'),
    import('../lib/repo/apps'),
    import('../core/settings/external-apps'),
    import('../core/ctx'),
    import('./app-icon'),
    import('../lib/hostname'),
    import('../lib/stage'),
    import('../lib/site'),
  ])
  const ws = await readWorkspaces()
  // No snapshot (or a broken one) is not "no workspaces": keep what is there.
  if (!ws.available || ws.error !== null) return
  const ctx = await makeCtx()
  const [records, external] = await Promise.all([listApps(), listExternalApps(ctx)])
  const resolvers = new Map<string, () => Promise<ResolvedIcon | null>>()
  const projects: { repo: string; key: string }[] = []
  for (const r of records) {
    const key = `app:${r.name}`
    projects.push({ repo: appRepo(ctx.site, r.name), key })
    resolvers.set(key, () =>
      appIcon(r.name, effectiveHostname(ctx.site, r.name, r.hostname), stageExposed(r.stage)),
    )
  }
  for (const e of external) {
    if (e.repo === null) continue
    const key = `site:${e.id}`
    projects.push({ repo: e.repo, key })
    resolvers.set(key, () => siteIcon(e.id, e.host))
  }
  const plan = iconPlan(ws.data.workspaces, projects)
  const resolved = new Map<string, ResolvedIcon>()
  await Promise.all(
    [...plan].map(async ([name, key]) => {
      const icon = await resolvers.get(key)?.()
      if (icon) resolved.set(name, icon)
    }),
  )
  await writeIcons(resolved)
}

/* ── running it ───────────────────────────────────────────────────────── */

type Slot = { handle: unknown; running: Promise<void> | null }
const SLOT = '__daedalusWorkspaceIcons'
const g = globalThis as unknown as Record<string, unknown>
const slot = (): Slot => {
  const v = g[SLOT]
  if (isRecord(v) && 'handle' in v) return v as Slot
  const s: Slot = { handle: null, running: null }
  g[SLOT] = s
  return s
}

/**
 * Half the workspace sync's 30 minutes: a new clone gets its icon soon after
 * it is published. Each run costs nothing past the icon cache's hour.
 */
const EXPORT_EVERY_MS = 15 * 60_000

/** One export now, unless one is running. Never throws. */
export function requestIconExport(): Promise<void> {
  const s = slot()
  if (s.running !== null) return s.running
  const run = exportOnce()
    .catch((e: unknown) => {
      console.warn(`workspace icons not exported: ${e instanceof Error ? e.message : String(e)}`)
    })
    .finally(() => {
      s.running = null
    })
  s.running = run
  return run
}

/** The quarter-hour run, started once per process by host/background.ts. Idempotent. */
export function ensureIconExport(): void {
  const s = slot()
  if (s.handle !== null) return
  const handle = setInterval(() => void requestIconExport(), EXPORT_EVERY_MS)
  ;(handle as { unref?: () => void }).unref?.()
  s.handle = handle
  void requestIconExport()
}

/** Stop the quarter-hour run; an export already running finishes. Idempotent. */
export function stopIconExport(): void {
  const s = slot()
  if (s.handle !== null) clearInterval(s.handle as ReturnType<typeof setInterval>)
  s.handle = null
}
