import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'system',
  label: 'System',
  // One lede for every machine on the picker, so the head and the tabs
  // below it never move when the machine changes.
  lede: 'This box, or another machine on the network: what it runs on, what it stores, how it is doing.',
  order: 60,
  // Shaped to Host, the tab that opens by default.
  boardSpans: [8, 4, 4, 4],
  // No dots anywhere on this row. Every other category's tabs are services,
  // and gatus probes services; these are layers of one machine, and the page
  // you are reading is running on it. A row of permanently grey circles
  // would be claims that nothing is being checked, which is false — the
  // checking is on the page.
  //
  // The first rule separates the state of the machine NOW from what outlives
  // it. Everything left of it is gone the moment the box is; Backups is the
  // only tab here answering a question about tomorrow.
  //
  // `head: false` on every tab before the second rule, for the same reason as
  // the dots: these are layers of a machine, and a header saying "version
  // 6.12.93, current, Open ↗" is a claim about a service that is not there.
  // No `nix` anywhere: every tab here is the machine, and the machine is
  // always shown. (The shared postgres cluster, a service the box can switch
  // off, is the Database module.)
  //
  // A machine picker above the tabs, and with it a different place on the
  // rail: a module about every machine on the network is not a directory
  // entry for something this box runs, so the rail draws it below, on its
  // own. A node's System page keeps these tab ids — Host, Memory, Disks,
  // Build, Updates, Claude — over the one document its agent publishes and
  // its Claude report (components/machine-system/, components/claude-node);
  // Pools, Backups and Shotter are the box's alone.
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
    // case with a screwdriver. Three thirds and a wide row — the components
    // are peers, so none of them gets to be the big panel.
    { id: 'build', label: 'Build', boardSpans: [4, 4, 4, 12], head: false },
    // The one part of the build with a version and a maker who moves it.
    // Build says what the board IS; this says what firmware it runs, what
    // the maker has published since, and what each release changed — read
    // from the maker's download host, since its website refuses this box.
    { id: 'board', label: 'Motherboard', boardSpans: [4, 8, 12], head: false },
    // The one tab in this row whose subject is the fleet rather than a layer
    // of the machine — every digest-pinned container and whether it is
    // behind. It sits here because it is the box's own maintenance state,
    // and because much of what it lists (the exporters, the sidecars) has no
    // other page in this app to sit on.
    //
    // No head, like its neighbours: dozens of containers have no one version
    // and no one thing to open.
    //
    // Four full-width boards: the engine's own pin, the NixOS release, then
    // the two image lists (behind, and on the newest tag) — plus the update
    // queue between them while anything is queued or running.
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
    // Who maintains it. The remote-control server that lets this machine be
    // worked on from anywhere is a fact about the machine, not a service
    // among the categories, and it exists on every machine on the network
    // — which is why it is a tab here, after the second rule, rather than
    // a page of its own on the rail. These two keep a head: unlike the
    // layers above, a server has a version and a verdict.
    {
      id: 'claude',
      label: 'Claude',
      icon: 'claude',
      boardSpans: [4, 8, 12, 6, 6],
      dividerBefore: true,
    },
    // The sessions' eyes: the headless browser a session drives to look at
    // a page. The box's alone — the browser lab is here.
    { id: 'shotter', label: 'Shotter', boardSpans: [4, 8, 12] },
  ],
} as const satisfies ModuleManifest
