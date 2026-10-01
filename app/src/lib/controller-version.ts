import { AGENT_VERSION } from '../host/controller/generated/constants'

// The controller and this app ship from one engine: the app's wire types
// are generated from the agent the engine builds (host/controller/generated/),
// and the box's controller runs that agent once the engine is applied. Until
// it is — the app moves on save, the controller with a lock bump — the two
// may speak contracts that differ, and the page says so rather than reading
// what it does not share.

/** The controller's agent and the one this app was built beside, when they are different releases. */
export type ControllerSkew = { runs: string; ships: string }

/**
 * Whether the controller runs another release than the one this app's
 * engine builds. A build's `+<id>` (the box names its builds by their
 * source's hash) is not a release: only the version before it is compared.
 */
export function controllerSkew(runs: string, ships: string = AGENT_VERSION): ControllerSkew | null {
  const release = runs.split('+')[0] ?? runs
  return release === ships ? null : { runs: release, ships }
}
