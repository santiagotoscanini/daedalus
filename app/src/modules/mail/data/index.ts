// The Email module's data half: one tab per way mail crosses the box.
//
// The relay is the platform's (msmtp, every box has it), so its tab is on
// every box; the reader is lib/dashboard/mail-relay.ts, shared with
// Monitoring › Alerts. Proton Mail Bridge is a stack a box may not run: its
// tab fronts the `proton-bridge` module, and host/modules.ts never calls its
// loader while that is off.

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { loadProton, type ProtonData } from './proton'
import { loadRelay, type RelayData } from './relay'

export type Tabs = { relay: RelayData; proton: ProtonData }
export type MailData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  relay: loadRelay,
  proton: loadProton,
})
