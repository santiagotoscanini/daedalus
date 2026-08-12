// The Media category: a tab per JOB, in the order a file travels, and a switch
// inside the page for the services that share one.
//
// This replaced a two-tab page (a pipeline diagram, then a directory of eleven
// tiles) and the reason is what a tile could never hold. Every service here is
// a pinned image that is never automatically up to date — CLAUDE.md's
// `--pull missing` note applies to all of them — and every one of them has its
// own idea of whether it is healthy. Three stats and a link could not say
// either thing, so eleven services shared one page on which nothing was
// answerable and nine of them were a number nobody had asked for.
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
// what no API can say — a month of disk growth — and Loki only for the three
// services that publish no numbers at all. This is the opposite of the old
// page's rule, and the reason is that these panels are read WHILE something is
// wrong: scraparr's copy of a queue depth is up to a minute old, which is a
// minute of watching a stalled import that already cleared.

import { type CalibreData, loadCalibre } from './calibre'
import { type CleanupData, loadCleanup } from './cleanup'
import { type DownloadsData, loadDownloads } from './downloaders'
import { loadProwlarr, type ProwlarrData } from './indexer'
import { type JellyfinData, loadJellyfin } from './jellyfin'
import type { Ctx } from './shared'
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
 * Seven tabs rather than the sixteen containers behind them, because several
 * of those containers are one job split across processes for historical
 * reasons rather than for the reader's. Seerr, Sonarr and Radarr answer one
 * question — what should be here that isn't. qBittorrent, NZBGet and MeTube
 * answer another — what is coming down the wire. Giving each of them a tab
 * made the reader reassemble a job the software had already split.
 *
 * The same shape the Network category uses for its three ways in: the tab is
 * the subject, the switch picks which implementation of it you are looking at,
 * and each option carries its own health dot so the choice is informed before
 * it is made.
 *
 * A service earns a switch option by having a PAGE — something to say beyond
 * its log. flaresolverr, subgen and scraparr have no reachable API at all, so
 * they stay folded under the log of the tab they serve.
 */
export type MediaData =
  | ({ tab: 'jellyfin' } & JellyfinData)
  | ({ tab: 'calibre' } & CalibreData)
  | {
      tab: 'wanted'
      seerr: SeerrData
      sonarr: ArrData
      radarr: ArrData
      recyclarr: RecyclarrData
      bazarr: BazarrData
    }
  | ({ tab: 'indexer' } & ProwlarrData)
  | ({ tab: 'downloaders' } & DownloadsData)
  | ({ tab: 'cleanup' } & CleanupData)

export async function loadMedia(tab: string, ctx: Ctx): Promise<MediaData> {
  switch (tab) {
    case 'calibre':
      return { tab: 'calibre', ...(await loadCalibre(ctx)) }
    case 'wanted': {
      // All five, because all five are on the page — the switch chooses what
      // is SHOWN, not what is fetched. Fetching on selection would put a
      // spinner behind a button that is meant to feel like a toggle.
      const [seerr, sonarr, radarr, recyclarr, bazarr] = await Promise.all([
        loadSeerr(ctx.base('seerr')),
        loadArr('sonarr', ctx),
        loadArr('radarr', ctx),
        loadRecyclarr(),
        loadBazarr(ctx),
      ])
      return { tab: 'wanted', seerr, sonarr, radarr, recyclarr, bazarr }
    }
    case 'indexer':
      return { tab: 'indexer', ...(await loadProwlarr(ctx)) }
    case 'downloaders':
      return { tab: 'downloaders', ...(await loadDownloads(ctx)) }
    case 'cleanup':
      return { tab: 'cleanup', ...(await loadCleanup()) }
    default:
      return { tab: 'jellyfin', ...(await loadJellyfin(ctx.base('jellyfin'))) }
  }
}

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
