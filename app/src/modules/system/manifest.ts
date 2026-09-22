import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'system',
  label: 'System',
  lede: 'The machine itself: what it is running on, what it is storing, and what survives it.',
  order: 60,
  // Shaped to Host, the tab that opens by default.
  boardSpans: [8, 4, 4, 4],
  // No dots anywhere on this row. Every other category's tabs are services,
  // and gatus probes services; these are layers of one machine, and the page
  // you are reading is running on it. A row of permanently grey circles
  // would be seven claims that nothing is being checked, which is false —
  // the checking is on the page.
  //
  // The rule separates the state of the machine NOW from what outlives it.
  // Everything left of it is gone the moment the box is; Backups is the only
  // tab here answering a question about tomorrow.
  //
  // `head: false` throughout, and it is the same argument as the dots: these
  // are layers of a machine, and a header saying "version 6.12.93, current,
  // Open ↗" is a claim about a service that is not there. No `nix` either:
  // every tab here is the machine, and the machine is always shown. The one
  // tab that had both — the shared postgres cluster, a service with a version
  // and a release cycle that the box can switch off — is the Database module
  // now, one rail entry down; and the other machines on the network are
  // Settings › Machines, beside the policy the box sends them.
  // A machine picker above the tabs: a node's System page is one view of
  // its telemetry (components/machine-system.tsx) rather than these tabs.
  machinePicker: true,
  tabs: [
    { id: 'host', label: 'Host', boardSpans: [8, 4, 4, 4], head: false },
    { id: 'memory', label: 'Memory', boardSpans: [8, 4, 4, 8], head: false },
    // Physical, then logical. SMART and throughput belong to a device;
    // capacity and snapshots belong to a pool, and one page holding both
    // was the same paragraph answering two questions.
    // Three thirds and a footer: one board per drive in this box, which is
    // the count the skeleton has to guess at because the disks are data.
    { id: 'disks', label: 'Disks', boardSpans: [4, 4, 4, 12], head: false },
    { id: 'pools', label: 'Pools', boardSpans: [6, 6, 12], head: false },
    // The parts, as opposed to the layers. Every other tab in this row
    // answers "how is it behaving"; this one answers "what is it", which is
    // the question you cannot look up when you are in front of the open
    // case with a screwdriver. Four thirds and a wide row — the components
    // are peers, so none of them gets to be the big panel.
    { id: 'build', label: 'Build', boardSpans: [4, 4, 4, 12], head: false },
    // The one tab in this row whose subject is the fleet rather than a layer
    // of the machine — every digest-pinned container and whether it is
    // behind. It sits here because it is the box's own maintenance state,
    // and because a third of what it lists (the exporters, the sidecars, the
    // exporters and sidecars) has no other page in this app to sit on.
    //
    // No head, like its neighbours: sixty-five containers have no one
    // version and no one thing to open.
    //
    // Four full-width boards: the engine's own pin, the NixOS release, then
    // the two image lists (behind, and on the newest tag).
    {
      id: 'updates',
      label: 'Updates',
      boardSpans: [12, 12, 12, 12],
      head: false,
    },
    {
      id: 'backups',
      label: 'Backups',
      boardSpans: [8, 4, 8, 4],
      head: false,
      dividerBefore: true,
    },
  ],
} as const satisfies ModuleManifest
