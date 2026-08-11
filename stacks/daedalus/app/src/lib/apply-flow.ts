// The one apply implementation.
//
// Both doors — the Apply button (server/registry.ts) and the scriptable
// POST /api/registry/apply — call runApply and only translate its outcome
// into their own response shape. Before this module they were two hand-copied
// bodies that could drift; the route's header even claimed otherwise.

export type ApplyOutcome =
  | { ok: true; id: string; changed: { name: string; fields: string[] }[] }
  | { ok: false; code: 'busy' | 'noop'; reason: string }

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

export function runApply(actor: string): Promise<ApplyOutcome> {
  const outcome = chain.then(() => locked(actor))
  chain = outcome.catch(() => undefined)
  return outcome
}

async function locked(actor: string): Promise<ApplyOutcome> {
  const { listApps, toRegistryExport, driftOf } = await import('./repo/apps')
  const { manifestEntries } = await import('./nix-manifest')
  const { requestApply, summarise, readApplyStatus } = await import('./apply')
  const { renderRegistryFile } = await import('./registry-file')

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

  const records = await listApps()
  const manifest = new Map((await manifestEntries()).map((m) => [m.name, m]))

  const changed = records
    .filter((r) => !r.managedInNix)
    .map((r) => ({ name: r.name, fields: driftOf(r, manifest.get(r.name)) }))
    .filter((c) => c.fields.length > 0)

  if (changed.length === 0) {
    return { ok: false, code: 'noop', reason: 'nothing to apply' }
  }

  const id = await requestApply({
    // The finished file, not a data structure: the host agent copies these
    // bytes into the flake verbatim and never parses the registry.
    fileBody: renderRegistryFile(toRegistryExport(records)),
    summary: summarise(changed),
    actor,
  })
  pending = { id, at: Date.now() }

  return { ok: true, id, changed }
}
