// The Media module's data half: a tab per JOB, in the order a file travels,
// and a switch inside the page for the services that share one.
//
// Every service here is a pinned image that is never automatically up to date
// (oci-containers runs `--pull missing`), and every one has its own idea of
// whether it is healthy — which is what each page exists to say.
//
// ── what every service page owes the reader ───────────────────────────────
//
// The same three things, in the same place: what version is running and what
// is between it and current, what the service itself says is wrong, and its
// log — with the logs of any container that has nowhere else to be read folded
// underneath. flaresolverr, subgen and scraparr are on this page for exactly
// that reason: each is a plausible answer to "it failed and its own log blamed
// its upstream", none has an API this box can reach, and so none has a page.
//
// ── where a number comes from ─────────────────────────────────────────────
//
// The service's own API, wherever it will answer. Prometheus is used only for
// what no API can say — the library disks, the VPN's state — and Loki only for
// the services that publish no numbers at all (Recyclarr, Janitorr, and
// Cleanuparr's counts). Not scraparr's prometheus copy of the *arrs, because
// these panels are read WHILE something is wrong: its queue depth is up to a
// minute old, which is a minute of watching a stalled import that already
// cleared.

import { defineLoader, type TabPayload } from '../../../lib/modules/tabs'
import { manifest } from '../manifest'
import { type CalibreData, loadCalibre } from './calibre'
import { type CleanupData, loadCleanup } from './cleanup'
import { type DownloadsData, loadDownloads } from './downloaders'
import { loadProwlarr, type ProwlarrData } from './indexer'
import { type JellyfinData, loadJellyfin } from './jellyfin'

import {
  type ArrData,
  type BazarrData,
  loadArr,
  loadBazarr,
  loadRecyclarr,
  loadSeerr,
  type RecyclarrData,
  type SeerrData,
} from './wanted'

/**
 * A tab is a JOB; the services doing it are a switch inside the page.
 *
 * Six tabs rather than the containers behind them, because several of those
 * containers are one job split across processes for reasons of the software's
 * rather than the reader's. Seerr, Sonarr and Radarr answer one question —
 * what should be here that isn't. qBittorrent, NZBGet and MeTube answer
 * another — what is coming down the wire. A tab each would make the reader
 * reassemble the job.
 *
 * The tab is the subject, the switch picks which implementation of it you are
 * looking at, and each option carries its own health dot so the choice is
 * informed before it is made.
 *
 * A service earns a switch option by having a PAGE — something to say beyond
 * its log; the sidecars above stay folded under the log of the tab they serve.
 */
export type Tabs = {
  jellyfin: JellyfinData
  calibre: CalibreData
  wanted: {
    seerr: SeerrData
    sonarr: ArrData
    radarr: ArrData
    recyclarr: RecyclarrData
    bazarr: BazarrData
  }
  indexer: ProwlarrData
  downloaders: DownloadsData
  cleanup: CleanupData
}
export type MediaData = TabPayload<typeof manifest, Tabs>

export const load = defineLoader<typeof manifest, Tabs>(manifest, {
  jellyfin: (ctx) => loadJellyfin(ctx),
  calibre: (ctx) => loadCalibre(ctx),
  wanted: async (ctx) => {
    // All five, because all five are on the page — the switch chooses what
    // is SHOWN, not what is fetched. Fetching on selection would put a
    // spinner behind a button that is meant to feel like a toggle.
    const [seerr, sonarr, radarr, recyclarr, bazarr] = await Promise.all([
      loadSeerr(ctx),
      loadArr('sonarr', ctx),
      loadArr('radarr', ctx),
      loadRecyclarr(ctx),
      loadBazarr(ctx),
    ])
    return { seerr, sonarr, radarr, recyclarr, bazarr }
  },
  indexer: (ctx) => loadProwlarr(ctx),
  downloaders: loadDownloads,
  cleanup: loadCleanup,
})

export type {
  ArrData,
  BazarrData,
  CalibreData,
  CleanupData,
  DownloadsData,
  JellyfinData,
  ProwlarrData,
  RecyclarrData,
  SeerrData,
}
