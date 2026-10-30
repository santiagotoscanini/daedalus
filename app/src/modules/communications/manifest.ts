import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'communications',
  label: 'Communications',
  // True on a box without a mailbox or a homeserver too: the relay is always
  // there, the rest only sometimes.
  lede: 'Every way messages cross the box: the relay its alerts leave through, and the mailboxes and chats it bridges.',
  // Right after Network: messages are the other thing that crosses the box's
  // edge, and the relay at the end of every alert path is a fact about the
  // box, not about the watchers on Monitoring.
  order: 55,
  section: 'Infrastructure',
  boardSpans: [12, 12, 12],
  tabs: [
    // The relay is the platform's and exists on every box, so its tab has no
    // `nix` and comes first. It is named after the provider the box relays
    // through (lib/mail-providers.ts, resolved by the server); "Relay" and
    // the envelope are its face on a box relaying anywhere else. No head: it
    // is an account, not a service with a version.
    {
      id: 'relay',
      label: 'Relay',
      icon: 'mail',
      brand: 'mail-relay',
      head: false,
      boardSpans: [12, 12, 12],
    },
    // Proton Mail Bridge, while the box runs the `proton-bridge` stack. No
    // dot: nothing probes it from outside, and its page is the check.
    {
      id: 'proton',
      label: 'Proton Mail',
      logo: '/icon-proton-mail.svg',
      nix: 'proton-bridge',
      boardSpans: [8, 4, 12, 12],
    },
    // The private homeserver and the bridges it carries, while the box runs
    // the `matrix` stack. No dot either: it listens on no address anything
    // outside its namespace can reach.
    {
      id: 'matrix',
      label: 'Matrix',
      logo: '/icon-matrix.svg',
      nix: 'matrix',
      boardSpans: [6, 6, 12],
    },
  ],
  // The one tab the page had before it split.
  aliases: { overview: 'relay' },
} as const satisfies ModuleManifest
