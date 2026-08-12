import type { VersionGap } from '../../../lib/dashboard/github'
import { type CompareRow, latestRow } from '../../service-head'

/**
 * The working, paired with the PIN rather than with the running version.
 *
 * The one place this dashboard departs from the shared `compareOf`, and on
 * purpose: on these four the running number and the pin are different facts.
 * Lemonade is installed on Windows and is in no flake at all; LiteLLM and Open
 * WebUI are digests pinned against a moving tag. "Running" would restate the
 * number already sitting two centimetres to the left; "pinned by" is the thing
 * you would have to go and edit.
 */
export function comparePinned(gap: VersionGap, note: string): CompareRow[] {
  return [latestRow(gap), { k: 'Pinned by', v: null, note }]
}
