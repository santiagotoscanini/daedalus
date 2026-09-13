import { createServerFn } from '@tanstack/react-start'
import { actorLabel } from '../core/auth'
import { type AccessWindow, isAccessWindow } from '../lib/access-window'
import { appName } from '../lib/hostname'
import { isRecord } from '../lib/is-record'
import type { Result } from '../lib/result'

// The RPC seam behind the Apps UI: the list page, the detail page, the create
// form and the apply bar. Nothing here does any work — each function proves
// what a request claims and hands it to the module that owns the subject
// (`src/lib/apps/*`), which is where the reading, the fan-out and the "why"
// comments live.
//
// ── why the seam and the work are different files ─────────────────────────
//
// Two rules push in the same direction. `src/server/**` may hold no static
// value import of a module that needs the machine (host/boundary.test.ts):
// anything it names statically lands in the client chunk of every route that
// imports a server function from it. So work written HERE has to reach its
// dependencies through `await import()`, one per call site — which is how this
// file came to hold fifty-four of them. Written in `src/lib/apps/` instead,
// which is a server region, the same dependencies are plain static imports and
// one dynamic import per handler loads the lot.
//
// ── why the function names and this filename cannot move ──────────────────
//
// Every `createServerFn` below is an RPC endpoint whose id the client has
// baked into its bundle, and TanStack Start derives that id from the file
// path plus the variable name — base64 of `{file, export}` in dev, sha256 of
// `<relative filename>--<variableName>_createServerFn_handler` in a build
// (@tanstack/start-plugin-core, start-compiler/compiler.ts). Moving one of
// these to another module, or renaming this file, silently changes its id:
// a browser tab still holding the old bundle then calls an id the server no
// longer serves. So the declarations stay put and the subjects split behind
// them.
//
// ── what a request has to prove ───────────────────────────────────────────
//
// Every validator below is a real check, not a type annotation: `.validator`
// takes `unknown` and parses, because the browser is what sends this and a
// `(input: { name: string }) => input` is a cast the request never agreed to.
// The deep handlers re-check what they act on — `getApp` answers null for a
// name it does not know, `validateNewApp` and `validateAppPatch` own the field
// rules — so what belongs here is the shape, refused with a sentence instead
// of thrown three frames down.
//
// `appName` is lib/hostname's, the same rule the create form applies: a name
// is a DNS label, a container name and a postgres role, and there is one
// definition of it.

/** The tab payload union. Re-exported so components name it from the seam. */
export type { AppTabData } from '../lib/apps/tabs'

export const fetchApps = createServerFn().handler(async () => {
  const { loadAppList } = await import('../lib/apps/list')
  return loadAppList()
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
  const { makeHosts } = await import('../host/hosts')
  return loadImages(await makeHosts())
})

/** The npm registry tab. See above for why it is not folded into that one. */
export const fetchPackagesTab = createServerFn().handler(async () => {
  const { loadPackages } = await import('../lib/apps/registries')
  const { makeHosts } = await import('../host/hosts')
  return loadPackages(await makeHosts())
})

export const fetchApp = createServerFn()
  .validator((data: unknown): { name: string } => {
    if (!isRecord(data)) throw new Error('expected an app name')
    return { name: appName(data.name) }
  })
  .handler(async ({ data }) => {
    const { loadAppDetail } = await import('../lib/apps/detail')
    return loadAppDetail(data)
  })

export const fetchAppTab = createServerFn()
  // `tab` is only checked to be a string: the switch behind this has a
  // default, and an unknown tab is a page that renders its settings, not a bad
  // request. `accessWindow` is not so forgiving — it indexes WINDOW_SPEC and
  // builds a Loki range — so it is the union it always claimed to be.
  .validator((data: unknown): { name: string; tab: string; accessWindow: AccessWindow } => {
    if (!isRecord(data)) throw new Error('expected an app tab request')
    if (typeof data.tab !== 'string') throw new Error('expected a tab')
    if (!isAccessWindow(data.accessWindow)) throw new Error('expected an access window')
    return { name: appName(data.name), tab: data.tab, accessWindow: data.accessWindow }
  })
  .handler(async ({ data }) => {
    const { loadAppTab } = await import('../lib/apps/tabs')
    return loadAppTab(data)
  })

export const fetchNewAppOptions = createServerFn().handler(async () => {
  const { loadNewAppOptions } = await import('../lib/apps/create')
  return loadNewAppOptions()
})

export const fetchAppPreflight = createServerFn()
  // Both fields are checked for their type and nothing more. This runs on
  // every keystroke in the create form, against a name the operator has not
  // finished choosing and a repository GitHub may well have called `My.Repo`
  // — the form's own `appNameError` is what says so, and refusing here would
  // turn a red input box into a failed request behind it.
  .validator((data: unknown): { name: string; image: string | null } => {
    if (!isRecord(data)) throw new Error('expected a name and an image')
    if (typeof data.name !== 'string') throw new Error('expected a name')
    const image = data.image ?? null
    if (image !== null && typeof image !== 'string') {
      throw new Error('expected an image or null')
    }
    return { name: data.name, image }
  })
  .handler(async ({ data }) => {
    const { appPreflight } = await import('../lib/apps/create')
    return appPreflight(data)
  })

export const createAppFn = createServerFn({ method: 'POST' })
  // The field rules are validateNewApp's, in lib/repo/apps next to the table
  // it writes — including the name, which it checks with appNameError so a
  // create refuses a reserved or taken label too. All this owes is a record to
  // hand it, which is also what retires the `as unknown as` the handler used
  // to need to pretend the cast above had happened.
  .validator((data: unknown): { app: Record<string, unknown> } => {
    if (!isRecord(data) || !isRecord(data.app)) throw new Error('expected an app to create')
    return { app: data.app }
  })
  .handler(async ({ data }): Promise<{ name: string }> => {
    const { createApp, validateNewApp } = await import('../lib/repo/apps')
    return createApp(validateNewApp(data.app))
  })

export const deleteAppFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { name: string } => {
    if (!isRecord(data)) throw new Error('expected an app name')
    return { name: appName(data.name) }
  })
  .handler(async ({ data }) => {
    const { deleteApp } = await import('../lib/repo/apps')
    await deleteApp(data.name)
    return { ok: true }
  })

export const saveApp = createServerFn({ method: 'POST' })
  // The field values are checked in validateAppPatch, where the field list
  // lives; this is the shape around them.
  .validator((data: unknown): { name: string; patch: Record<string, unknown> } => {
    if (!isRecord(data)) throw new Error('expected an app edit')
    if (!isRecord(data.patch)) throw new Error('patch must be an object')
    return { name: appName(data.name), patch: data.patch }
  })
  .handler(async ({ data }) => {
    const { updateApp, validateAppPatch } = await import('../lib/repo/apps')
    await updateApp(data.name, validateAppPatch(data.patch))
    return { ok: true }
  })

/**
 * Publish an apply request — an adapter over host/apply-flow.ts, which owns
 * the whole check-and-write. The only thing decided here is the actor:
 * whoever passed the Pocket ID gate. The forward-auth middleware forwards
 * the claim as a header (auth.headers in stacks/daedalus/daedalus.nix), so
 * the commit records a person rather than "daedalus".
 */
export const applyRegistry = createServerFn({ method: 'POST' }).handler(
  // The outcome's `code` stops here: it exists so the scriptable door
  // (routes/api.registry.apply.ts) can map a refusal to an HTTP status, and
  // the button has nothing to do with it but read the sentence.
  async (): Promise<Result<{ id: string; changed: { name: string; fields: string[] }[] }>> => {
    const { runApply } = await import('../host/apply-flow')
    const outcome = await runApply(actorLabel())
    return outcome.ok
      ? { ok: true, value: { id: outcome.id, changed: outcome.changed } }
      : { ok: false, reason: outcome.reason }
  },
)

export const fetchApplyStatus = createServerFn().handler(async () => {
  const { readApplyStatus } = await import('../host/apply')
  return readApplyStatus()
})

export const triggerDeploy = createServerFn({ method: 'POST' })
  // The one server function here whose request is the bare name rather than a
  // record around it.
  .validator((data: unknown): string => appName(data))
  .handler(async ({ data: name }) => {
    const { requestManualDeploy } = await import('../lib/apps/deploy')
    return requestManualDeploy(name)
  })

export const revealEnvVar = createServerFn({ method: 'POST' })
  .validator((data: unknown): { name: string; key: string } => {
    if (!isRecord(data)) throw new Error('expected an app and a variable')
    if (typeof data.key !== 'string' || data.key === '') throw new Error('expected a variable name')
    return { name: appName(data.name), key: data.key }
  })
  .handler(async ({ data }) => {
    const { revealAppEnvVar } = await import('../lib/apps/secrets')
    return revealAppEnvVar(data)
  })

export const fetchDeployStatus = createServerFn().handler(async () => {
  const { readDeployStatus } = await import('../host/deploy')
  return readDeployStatus()
})

export const cloneWorkspaceFn = createServerFn({ method: 'POST' })
  // A string, then the allowlist in lib/apps/workspaces.ts — which is the
  // check that matters and cannot live here, since it is built from the
  // registry.
  .validator((data: unknown): { repo: string } => {
    if (!isRecord(data) || typeof data.repo !== 'string') throw new Error('expected a repo')
    return { repo: data.repo }
  })
  .handler(async ({ data }) => {
    const { cloneOfferedWorkspace } = await import('../lib/apps/workspaces')
    return cloneOfferedWorkspace(data)
  })

export const fetchWorkspaceRequestStatus = createServerFn().handler(async () => {
  const { readWorkspaceRequestStatus } = await import('../host/workspaces')
  return readWorkspaceRequestStatus()
})
