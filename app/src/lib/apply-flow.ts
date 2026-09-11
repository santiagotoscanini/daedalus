// The one apply implementation.
//
// Both doors — the Apply button (server/registry.ts) and the scriptable
// POST /api/registry/apply — call runApply and only translate its outcome
// into their own response shape. Before this module they were two hand-copied
// bodies that could drift; the route's header even claimed otherwise.
//
// runSecretApply is the third door, for a vault secret set from Settings
// (core/settings/cloudflare-token.ts, core/settings/github-signin.ts). It shares the lock, the busy checks and
// the pickup window, and differs in one rule: it is always its own Apply.

export type ApplyOutcome =
  | { ok: true; id: string; changed: { name: string; fields: string[] }[] }
  | { ok: false; code: 'busy' | 'noop' | 'pending'; reason: string }

/**
 * How long a published request may sit unclaimed before a new apply is
 * allowed to overwrite it. The path unit normally reacts within a second or
 * two; a request still foreign to status.json after two minutes means the
 * host agent is not coming for it, and refusing forever would wedge the
 * button until a container restart.
 */
const PICKUP_MS = 120_000

/**
 * The last request this process published and has not yet seen the host
 * acknowledge in status.json. This is what closes the window the status file
 * cannot: between requestApply returning and apply.sh writing `running`, the
 * file still shows the PREVIOUS run's terminal state, so a second apply
 * racing through the file check alone would replace apps.json under a rebuild
 * that is about to read it.
 *
 * Process-local on purpose: this container is the only writer into /apply,
 * and a single node process serves both doors.
 */
let pending: { id: string; at: number } | null = null

/** Serialises appliers: the check-then-write below must not interleave. */
let chain: Promise<unknown> = Promise.resolve()

function serialised(work: () => Promise<ApplyOutcome>): Promise<ApplyOutcome> {
  const outcome = chain.then(work)
  chain = outcome.catch(() => undefined)
  return outcome
}

export function runApply(actor: string): Promise<ApplyOutcome> {
  return serialised(() => locked(actor))
}

/** Why a new apply may not start now, or null when it may. */
async function refuseBusy(): Promise<ApplyOutcome | null> {
  const { readApplyStatus } = await import('./apply')

  // Refuse while one is in flight. The host script holds fleet.rebuildLock, so
  // a second apply could not corrupt anything — it would simply queue behind
  // it and then write a registry snapshot taken BEFORE the first one landed.
  // Rejecting here is both faster feedback and the correct answer.
  const inFlight = await readApplyStatus()
  if (inFlight.state === 'running') {
    return { ok: false, code: 'busy', reason: `an apply is already running (${inFlight.phase})` }
  }

  if (pending !== null) {
    if (inFlight.id === pending.id) {
      // The host has caught up: status now speaks for our request, and the
      // `running` check above is the guard again.
      pending = null
    } else if (Date.now() - pending.at < PICKUP_MS) {
      return {
        ok: false,
        code: 'busy',
        reason: 'the previous apply request has not been picked up by the host yet',
      }
    } else {
      pending = null
    }
  }
  return null
}

/** What an Apply would carry right now: app drift and site-document edits. */
async function currentChanges() {
  const { listApps, driftOf } = await import('./repo/apps')
  const { manifestEntries } = await import('./nix-manifest')

  const records = await listApps()
  const manifest = new Map((await manifestEntries()).map((m) => [m.name, m]))

  const appChanges = records
    .filter((r) => !r.managedInNix)
    .map((r) => ({ name: r.name, fields: driftOf(r, manifest.get(r.name)) }))
    .filter((c) => c.fields.length > 0)

  // The site document rides the same Apply: one rebuild for everything that
  // changed, in whichever file. Its changes are listed under the name `site`
  // so the bar can say what they are beside the apps.
  const { makeCtx } = await import('../core/ctx')
  const { siteEdit } = await import('../core/site')
  const site = await siteEdit(await makeCtx())
  const changed =
    site.changes.length > 0
      ? [...appChanges, { name: 'site', fields: [...site.changes] }]
      : appChanges

  return { records, site, changed }
}

async function commitSwitch(): Promise<boolean> {
  const { readSetting, SETTING_KEYS } = await import('./repo/settings')
  // Whether the host commits the write under site/ — the same switch the
  // Site tab sets. Off means staged and left to the operator.
  return (
    (await readSetting(SETTING_KEYS.siteCommit, (v): v is boolean => typeof v === 'boolean')) ??
    false
  )
}

async function locked(actor: string): Promise<ApplyOutcome> {
  const { toRegistryExport } = await import('./repo/apps')
  const { requestApply, summarise } = await import('./apply')
  const { renderRegistryFile } = await import('./registry-file')

  const blocked = await refuseBusy()
  if (blocked !== null) return blocked

  const { records, site, changed } = await currentChanges()
  if (changed.length === 0) {
    return { ok: false, code: 'noop', reason: 'nothing to apply' }
  }

  const id = await requestApply({
    // Finished files, not data structures: the host agent writes these bytes
    // verbatim and never parses either. apps.json always — its render is
    // idempotent and the agent reports no-change; site.json only when its
    // desired document differs from the committed one.
    files: {
      'apps.json': renderRegistryFile(toRegistryExport(records)),
      ...(site.changes.length > 0 ? { 'site.json': site.render.after } : {}),
    },
    summary: summarise(changed),
    actor,
    commit: await commitSwitch(),
  })
  pending = { id, at: Date.now() }

  return { ok: true, id, changed }
}

export type VaultFile = import('./vault').VaultFile

const pendingReason = (other: { name: string }[]) =>
  `Apply or undo the pending changes first (${other.map((c) => c.name).join(', ')}): replacing a secret is its own Apply.`

/**
 * Why a vault secret could not be applied right now, or null when it could.
 *
 * For work that cannot be repeated for free, asked before it starts: a GitHub
 * sign-in mints a token, and one minted and then refused here is a token
 * nobody can use. runSecretApply asks again at the moment it writes.
 */
export async function secretApplyBlocker(): Promise<string | null> {
  const blocked = await refuseBusy()
  if (blocked !== null && !blocked.ok) return blocked.reason
  const { changed } = await currentChanges()
  return changed.length > 0 ? pendingReason(changed) : null
}

/**
 * Replace one vault secret. Always its own Apply: refused while anything else
 * is pending, so a rotation never rides along with an unrelated change (nor an
 * unrelated change with it), and its commit names only which secret moved —
 * never a value, which this function only ever holds as ciphertext.
 *
 * `extraFiles` ride the same request, for a secret whose public half belongs
 * in site.json (the GitHub App's id beside its sealed key): rendered by the
 * caller from the COMMITTED document, since anything pending is refused here.
 */
export function runSecretApply(
  actor: string,
  secret: { file: VaultFile; name: string; ciphertext: string },
  opts?: { extraFiles?: Pick<import('./apply').ApplyFiles, 'site.json'> },
): Promise<ApplyOutcome> {
  return serialised(async () => {
    const { requestApply } = await import('./apply')

    const blocked = await refuseBusy()
    if (blocked !== null) return blocked

    const { changed: other } = await currentChanges()
    if (other.length > 0) {
      return { ok: false, code: 'pending', reason: pendingReason(other) }
    }

    const id = await requestApply({
      files: { ...opts?.extraFiles, [secret.file]: secret.ciphertext },
      summary: `replace ${secret.name}`,
      actor,
      commit: await commitSwitch(),
    })
    pending = { id, at: Date.now() }
    return { ok: true, id, changed: [{ name: 'vault', fields: [secret.name] }] }
  })
}
