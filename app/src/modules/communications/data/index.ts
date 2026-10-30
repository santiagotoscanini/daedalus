// The Communications module's data half: one tab per way messages cross the
// box.
//
// The relay is the platform's (msmtp, every box has it), so its tab is on
// every box; the reader is lib/dashboard/mail-relay.ts, shared with
// Monitoring › Alerts. Proton Mail Bridge and the Matrix homeserver are stacks
// a box may not run: their tabs front the `proton-bridge` and `matrix`
// modules, and host/modules.ts never calls a loader while its module is off.

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { loadMatrix, type MatrixData } from './matrix'
import { loadProton, type ProtonData } from './proton'
import { loadRelay, type RelayData } from './relay'

export type Tabs = { relay: RelayData; proton: ProtonData; matrix: MatrixData }
export type CommunicationsData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  relay: loadRelay,
  proton: loadProton,
  matrix: loadMatrix,
})
