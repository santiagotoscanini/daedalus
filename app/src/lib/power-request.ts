import { defineBridge } from './bridge'

// Asking the host to restart the machine.
//
// The narrowest bridge here on purpose: one verb, `reboot`, and the host agent
// (stacks/daedalus/host/power.sh) has no branch for powering the box OFF. That
// asymmetry is the requirement, not a default — the way back on is physical,
// and whoever is looking at this page is usually not in the house.
//
// It is also the only bridge with no terminal state. The host writes `running`
// and then dies with the machine, so `done` will never be observed and is not
// in the union below; the UI stops reading this file at that point and watches
// /api/healthz for the box coming back. `failed` is reachable only BEFORE the
// reboot — an unknown verb, or a rebuild in flight.
//
// Bridge mechanics (temp + rename, payload-before-trigger): lib/bridge.ts.

export type PowerAction = 'reboot'
export type PowerRequestState = 'idle' | 'running' | 'failed'

export type PowerRequestStatus = {
  id: string | null
  action: PowerAction | null
  state: PowerRequestState
  /** What the host is doing, in its words. `rebooting` is the only value. */
  detail: string
  error: string
  startedAt: string | null
  finishedAt: string | null
}

const bridge = defineBridge<PowerRequestStatus>({
  requestFile: 'power-request.json',
  statusFile: 'power-status.json',
  idle: {
    id: null,
    action: null,
    state: 'idle',
    detail: '',
    error: '',
    startedAt: null,
    finishedAt: null,
  },
})

/**
 * Only meaningful while a request of this page's own making is in flight: a
 * status left over from the last restart says `running` forever, because the
 * run that wrote it ended with the machine. Callers match on their own id.
 */
export async function readPowerRequestStatus(): Promise<PowerRequestStatus> {
  return bridge.readStatus()
}

export async function requestReboot(input: { actor: string }): Promise<string> {
  return bridge.request({ action: 'reboot', actor: input.actor })
}
