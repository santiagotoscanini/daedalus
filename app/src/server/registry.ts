import { isAccessWindow } from '../lib/access-window'
import { asValidator, is, nullable, obj, optional, str, withMessage } from '../lib/contract/decode'
import {
  appNameField,
  nonEmptyStringField,
  recordField,
  secretKeyField,
  taskIdField,
} from '../lib/contract/fields'
import type { Result } from '../lib/result'
import { adminFn, readFn } from './fn'

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
// Every server function below is an RPC endpoint whose id the client has
// baked into its bundle, and TanStack Start derives that id from the file
// path plus the variable name — base64 of `{file, export}` in dev, sha256 of
// the relative filename, the variable name and a fixed suffix in a build
// (@tanstack/start-plugin-core, start-compiler/compiler.ts). Moving one of
// these to another module, or renaming this file, silently changes its id:
// a browser tab still holding the old bundle then calls an id the server no
// longer serves. So the declarations stay put and the subjects split behind
// them.
//
// ── what a request has to prove ───────────────────────────────────────────
//
// Every validator below is a real check, not a type annotation: `.validator`
// takes `unknown` and decodes it (lib/contract/decode.ts), because the browser
// is what sends this and a `(input: { name: string }) => input` is a cast the
// request never agreed to.
// The deep handlers re-check what they act on — `getApp` answers null for a
// name it does not know, `validateNewApp` and `validateAppPatch` own the field
// rules — so what belongs here is the shape, refused with a sentence instead
// of thrown three frames down.
//
// `appNameField` is lib/hostname's `isAppName`, the same rule the create form applies: a name
// is a DNS label, a container name and a postgres role, and there is one
// definition of it.

/** The tab payload union. Re-exported so components name it from the seam. */
export type { AppTabData } from '../lib/apps/tabs'

export const fetchApps = readFn.handler(async () => {
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
export const fetchImagesTab = readFn.handler(async () => {
  const { loadImages } = await import('../lib/apps/registries')
  const { makeHosts } = await import('../host/hosts')
  return loadImages(await makeHosts())
})

/** The npm registry tab. See above for why it is not folded into that one. */
export const fetchPackagesTab = readFn.handler(async () => {
  const { loadPackages } = await import('../lib/apps/registries')
  const { makeHosts } = await import('../host/hosts')
  return loadPackages(await makeHosts())
})

export const fetchApp = readFn
  .validator(asValidator(withMessage(obj({ name: appNameField }), 'expected an app name')))
  .handler(async ({ data }) => {
    const { loadAppDetail } = await import('../lib/apps/detail')
    return loadAppDetail(data)
  })

export const fetchAppTab = readFn
  // `tab` is only checked to be a string: the switch behind this has a
  // default, and an unknown tab is a page that renders its settings, not a bad
  // request. `accessWindow` is not so forgiving — it indexes WINDOW_SPEC and
  // builds a Loki range — so it is the union it always claimed to be.
  //
  // The fields are read in the order the refusals should come: tab, window, name.
  .validator(
    asValidator(
      withMessage(
        obj({
          tab: withMessage(str, 'expected a tab'),
          accessWindow: withMessage(
            is(isAccessWindow, 'an access window'),
            'expected an access window',
          ),
          name: appNameField,
        }),
        'expected an app tab request',
      ),
    ),
  )
  .handler(async ({ data }) => {
    const { loadAppTab } = await import('../lib/apps/tabs')
    return loadAppTab(data)
  })

export const fetchNewAppOptions = readFn.handler(async () => {
  const { loadNewAppOptions } = await import('../lib/apps/create')
  return loadNewAppOptions()
})

export const fetchAppPreflight = readFn
  // Both fields are checked for their type and nothing more. This runs on
  // every keystroke in the create form, against a name the operator has not
  // finished choosing and a repository GitHub may well have called `My.Repo`
  // — the form's own `appNameError` is what says so, and refusing here would
  // turn a red input box into a failed request behind it.
  .validator(
    asValidator(
      withMessage(
        obj({
          name: withMessage(str, 'expected a name'),
          // Absent, undefined and null are all "no image".
          image: withMessage(optional(nullable(str), null), 'expected an image or null'),
        }),
        'expected a name and an image',
      ),
    ),
  )
  .handler(async ({ data }) => {
    const { appPreflight } = await import('../lib/apps/create')
    return appPreflight(data)
  })

export const createAppFn = adminFn
  // The field rules are validateNewApp's, in lib/repo/apps next to the table
  // it writes — including the name, which it checks with appNameError so a
  // create refuses a reserved or taken label too. All this owes is a record to
  // hand it, which is also what retires the `as unknown as` the handler used
  // to need to pretend the cast above had happened.
  .validator(asValidator(withMessage(obj({ app: recordField }), 'expected an app to create')))
  .handler(async ({ data }): Promise<{ name: string }> => {
    const { createApp, validateNewApp } = await import('../lib/repo/apps')
    return createApp(validateNewApp(data.app))
  })

export const deleteAppFn = adminFn
  .validator(asValidator(withMessage(obj({ name: appNameField }), 'expected an app name')))
  .handler(async ({ data }) => {
    const { deleteApp } = await import('../lib/repo/apps')
    await deleteApp(data.name)
    return { ok: true }
  })

export const saveApp = adminFn
  // The field values are checked in validateAppPatch, where the field list
  // lives; this is the shape around them.
  .validator(
    asValidator(
      withMessage(
        obj({
          patch: withMessage(recordField, 'patch must be an object'),
          name: appNameField,
        }),
        'expected an app edit',
      ),
    ),
  )
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
export const applyRegistry = adminFn.handler(
  // The outcome's `code` stops here: it exists for the MCP `apply` tool, whose
  // machine caller branches on it, and the button has nothing to do with it
  // but read the sentence.
  async ({
    context,
  }): Promise<Result<{ id: string; changed: { name: string; fields: string[] }[] }>> => {
    const { runApply } = await import('../host/apply-flow')
    const outcome = await runApply(context.actor())
    return outcome.ok
      ? { ok: true, value: { id: outcome.id, changed: outcome.changed } }
      : { ok: false, reason: outcome.reason }
  },
)

export const fetchApplyStatus = readFn.handler(async () => {
  const { readApplyStatus } = await import('../host/apply')
  return readApplyStatus()
})

/** Everything the next Apply would do, for the bar every page draws (host/pending-apply.ts). */
export const fetchPendingApply = readFn.handler(async () => {
  const { pendingApply } = await import('../host/pending-apply')
  return pendingApply()
})

export const triggerDeploy = adminFn
  // The one server function here whose request is the bare name rather than a
  // record around it.
  .validator(asValidator(appNameField))
  .handler(async ({ data: name }) => {
    const { requestManualDeploy } = await import('../lib/apps/deploy')
    return requestManualDeploy(name)
  })

export const revealEnvVar = adminFn
  .validator(
    asValidator(
      withMessage(
        obj({
          key: withMessage(nonEmptyStringField, 'expected a variable name'),
          name: appNameField,
        }),
        'expected an app and a variable',
      ),
    ),
  )
  .handler(async ({ data }) => {
    const { revealAppEnvVar } = await import('../lib/apps/secrets')
    return revealAppEnvVar(data)
  })

// ── the app-secrets editor ────────────────────────────────────────────────
//
// Write-only, and the validator is where that starts. The VALUE is never
// echoed back by any of these: `setAppSecretFn` returns a request id, the
// status poll returns key names, and there is no function anywhere that reads
// a secret out of the sops file — the container could not answer one.

export const setAppSecretFn = adminFn
  // The key's shape is checked here AND in lib/apps/secrets.ts AND by the
  // host agent. This one is the parse that lets the rest of the function
  // treat it as a name; the refusal an operator reads comes from the next.
  .validator(
    asValidator(
      withMessage(
        obj({
          key: secretKeyField,
          value: withMessage(str, 'expected a value'),
          name: appNameField,
        }),
        'expected an app, a variable and a value',
      ),
    ),
  )
  .handler(async ({ data, context }): Promise<Result<string>> => {
    const { setAppSecret } = await import('../lib/apps/secrets')
    return setAppSecret({ ...data, actor: context.actor() })
  })

export const removeAppSecretFn = adminFn
  .validator(
    asValidator(
      withMessage(
        obj({ key: secretKeyField, name: appNameField }),
        'expected an app and a variable',
      ),
    ),
  )
  .handler(async ({ data, context }): Promise<Result<string>> => {
    const { removeAppSecret } = await import('../lib/apps/secrets')
    return removeAppSecret({ ...data, actor: context.actor() })
  })

export const fetchSecretSetStatus = readFn.handler(async () => {
  const { readSecretSetStatus } = await import('../host/secret-set-request')
  return readSecretSetStatus()
})

export const fetchDeployStatus = readFn.handler(async () => {
  const { readDeployStatus } = await import('../host/deploy')
  return readDeployStatus()
})

export const cloneWorkspaceFn = adminFn
  // A string, then the allowlist in lib/apps/workspaces.ts — which is the
  // check that matters and cannot live here, since it is built from the
  // registry.
  .validator(asValidator(withMessage(obj({ repo: str }), 'expected a repo')))
  .handler(async ({ data }) => {
    const { cloneOfferedWorkspace } = await import('../lib/apps/workspaces')
    return cloneOfferedWorkspace(data)
  })

export const fetchWorkspaceRequestStatus = readFn.handler(async () => {
  const { readWorkspaceRequestStatus } = await import('../host/workspaces')
  return readWorkspaceRequestStatus()
})

/**
 * Run one of an app's scheduled tasks now, rather than at its next elapse.
 *
 * `taskId` is lib/tasks's — the same rule the export and the generated unit
 * name are built from — and it is the boundary that matters most on this page:
 * what this request names becomes part of a systemd unit that ROOT starts. So
 * the charset is refused here, the task is checked against the app's DECLARED
 * list in lib/apps/tasks.ts, and the host agent checks it a third time. None
 * of the three is meant to be the only one.
 */
export const runTaskNow = adminFn
  .validator(
    asValidator(
      withMessage(obj({ name: appNameField, task: taskIdField }), 'expected an app and a task'),
    ),
  )
  .handler(async ({ data }) => {
    const { runAppTaskNow } = await import('../lib/apps/tasks')
    return runAppTaskNow(data)
  })

export const fetchTaskRunStatus = readFn.handler(async () => {
  const { readTaskRunStatus } = await import('../host/task-run')
  return readTaskRunStatus()
})
