import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'media',
  label: 'Media',
  lede: 'Two libraries, and the chain that fills them.',
  order: 20,
  // Shaped to Jellyfin, the tab that opens by default.
  boardSpans: [8, 4, 4, 8],
  // No tile directory. It held eleven tiles, each three numbers and a link,
  // and every one of those services is now a tab with a page — the same name,
  // dot and link, plus the version verdict, the health checks and the log a
  // tile had no room for.
  // Split by what a thing IS, and the rule is the split: the two tabs to its
  // left are where a pipeline ENDS — the libraries a person actually opens —
  // and everything to its right is machinery that fills them.
  //
  // Four of these hold more than one service, picked by a switch inside the
  // page — the same shape Network uses for its three ways in. The grouping
  // follows the job rather than the software: Recyclarr sits with the two
  // *arrs whose configuration it writes, Bazarr with the other fetchers, and
  // Shelfmark with the other downloaders rather than beside the shelf it
  // fills, so "why has this not arrived" is answered in one place whether or
  // not the thing is a book.
  //
  // `probes` on those tabs rather than `probe`: every service behind the
  // switch has to be green, because picking one to represent the group would
  // draw a green dot over a broken half. Unknown on any makes the whole thing
  // unknown, which is the honest answer to a partial reading.
  //
  // `nix` names the stack that DECLARES each service on the tab, sidecars
  // included: a tab that folds flaresolverr's log under Prowlarr's is about
  // the downloads stack too, and hiding it while that stack still runs would
  // hide the one place that log can be read.
  tabs: [
    {
      id: 'jellyfin',
      label: 'Jellyfin',
      probe: 'jellyfin',
      boardSpans: [8, 4, 4, 8],
      nix: 'tv',
    },
    {
      id: 'calibre',
      label: 'Calibre',
      probe: 'calibre-web',
      boardSpans: [8, 4, 12],
      nix: 'calibre-web',
    },
    // Past the rule: everything that fills the two libraries above.
    {
      id: 'wanted',
      label: 'Wanted',
      probes: ['seerr', 'sonarr', 'radarr', 'bazarr'],
      boardSpans: [8, 4, 4, 8],
      dividerBefore: true,
      nix: ['tv', 'seerr', 'recyclarr', 'scraparr'],
    },
    {
      id: 'indexer',
      label: 'Indexer',
      probe: 'prowlarr',
      boardSpans: [12, 12, 12],
      nix: ['tv', 'downloads'],
    },
    {
      id: 'downloaders',
      label: 'Downloaders',
      probes: ['qbittorrent', 'nzbget', 'metube', 'shelfmark'],
      boardSpans: [8, 4, 4, 8],
      nix: ['tv', 'metube', 'shelfmark', 'downloads'],
    },
    // Only Cleanuparr answers HTTP; Janitorr is a timer with nothing to
    // probe, and carries its health inside on the switch instead.
    {
      id: 'cleanup',
      label: 'Cleanup',
      probe: 'cleanuparr',
      boardSpans: [8, 4, 12],
      nix: ['cleanuparr', 'janitorr'],
    },
  ],
} as const satisfies ModuleManifest
