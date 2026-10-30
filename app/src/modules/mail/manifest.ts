import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'mail',
  label: 'Email',
  // True on a box without Bridge too: the relay is always there, a bridged
  // mailbox only sometimes.
  lede: 'The relay this box’s alerts leave through, and any mailbox it bridges.',
  // Right after Network: mail is the other way messages cross the box's edge,
  // and the relay at the end of every alert path is a fact about the box, not
  // about the watchers on Monitoring.
  order: 55,
  section: 'Infrastructure',
  // Shaped to the page with Bridge: its accounts beside its facts, the
  // events, then the relay.
  boardSpans: [8, 4, 12, 12],
  // One tab, and two subjects on it, so no ServiceHead: a header naming one
  // service would put the relay under it. No `nix` either: the relay is the
  // platform's and exists on every box, so the page does too; the Proton
  // boards are there while `proton-bridge` is on (data/index.ts). No dot:
  // nothing probes either half from outside, and the page is the check.
  tabs: [{ id: 'overview', label: 'Overview', boardSpans: [8, 4, 12, 12], head: false }],
} as const satisfies ModuleManifest
