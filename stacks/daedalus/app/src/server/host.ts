import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'

// Server functions that act on the MACHINE rather than on an app.
//
// Its own module rather than a corner of registry.ts: everything there is the
// Apps UI's surface — the registry rows, the apply request, an app's deploy
// unit — and a restart belongs to none of it. The System category is the
// caller, and the one thing this shares with its neighbours (the file-drop
// bridge) already lives once in lib/.
//
// Value imports are dynamic for the same reason as registry.ts: the bridge
// module reaches for node:fs, and nothing here may be pulled into a client
// bundle.

/**
 * Ask the host to restart the box.
 *
 * Returns as soon as the request file is written — which is BEFORE the host has
 * decided anything. The caller polls the status for its own id to catch a
 * refusal (the host guards against rebooting mid-rebuild), and switches to
 * watching /api/healthz once the box is on its way down, because no completion
 * status will ever be written.
 */
export const requestRebootFn = createServerFn({ method: 'POST' }).handler(async () => {
  const { requestReboot } = await import('../lib/power-request')
  // The forward-auth middleware forwards the Pocket ID claim, so the request
  // records a person rather than "daedalus".
  const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'
  return { id: await requestReboot({ actor }) }
})

export const fetchPowerRequestStatus = createServerFn().handler(async () => {
  const { readPowerRequestStatus } = await import('../lib/power-request')
  return readPowerRequestStatus()
})
