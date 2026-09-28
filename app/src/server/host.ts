import { adminFn } from './fn'

// Server functions that act on the MACHINE rather than on an app.
//
// Its own module rather than a corner of registry.ts: everything there is the
// Apps UI's surface — the registry rows, the apply request, an app's deploy
// unit — and a restart belongs to none of it. The System category is the
// caller.

/**
 * Ask the box to restart: the root helper's `reboot`, through the controller
 * (host/power.ts). Answers once the host has decided — refused with its
 * reason (it will not reboot mid-rebuild), or the reboot queued, after which
 * the caller watches /api/healthz for the box going down and coming back.
 */
export const requestRebootFn = adminFn.handler(async ({ context }) => {
  const { requestReboot } = await import('../host/power')
  return requestReboot({ actor: context.actor() })
})
