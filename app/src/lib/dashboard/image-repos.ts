import type { GapOptions } from './github'
import { imageLabels } from './images'

// Which project's release notes belong to which container.
//
// Every service tab on this dashboard already answers this, one hardcoded
// `versionGap('owner/repo', …)` at a time, and that was fine while the only
// pages asking were the pages that had a service head. The Updates page asks
// about all sixty-five pinned containers at once — including the two dozen
// exporters, sidecars and janitors that have no tab, and whose changelog
// nobody could read anywhere in this app before it existed.
//
// ── why this is a table and not a label read ──────────────────────────────
//
// Images publish `org.opencontainers.image.source`, and it is tempting to
// treat that as the answer. It is not, and the failure is the same one
// lib/dashboard/images.ts documents for versions: the label is a claim the
// PUBLISHER made, and for a repackaged image the publisher is not the project.
//
// On this box, today: every linuxserver image points at its own packaging repo
// (`linuxserver/docker-radarr`), whose releases are `-lsNNN` build numbers
// rather than the Radarr versions anyone wants to read; `calibre-web`'s points
// at `linuxserver/docker-baseimage-ubuntu`, inherited from a base image and
// about a different piece of software entirely; `gluetun`'s points at a fork.
// Rendering any of those as "what changed" would be confidently wrong, which
// is worse than the blank it replaced.
//
// So the curated entry wins, the label is the fallback for a container nobody
// has curated, and a container with neither gets no notes rather than a guess.
// The tag deltas and candidate list still render — "there is a newer tag and
// we cannot tell you what is in it" is a real answer.

export type ReleaseSource = {
  repo: string
  opts?: GapOptions
  /**
   * Compare COMMITS on this branch instead of releases.
   *
   * For an image built off a moving branch, where a release list is not merely
   * uninformative but misleading — gluetun's `:latest` is master, which has
   * diverged from the v3.41.x line, so its release notes would advise a
   * downgrade into a known port-forwarding deadlock. See `commitsSince`.
   */
  branch?: string
}

/**
 * Container → where its release notes live.
 *
 * Keyed by CONTAINER, not by image: `immich` and `immich-machine-learning` are
 * one project and two containers, and every *arr rides one packaging repo.
 * Keying by image would make those separate questions.
 *
 * Every entry that a service tab also uses is the same repo and the same
 * options that tab passes — deliberately, so the Updates row and the service
 * page cannot disagree about what "3 behind" means.
 */
/**
 * The modules' own entries: each `src/modules/<id>/releases.ts` names the
 * containers that module fronts. Found, not listed, like the manifests. What
 * stays in the table below is the containers no tab owns — exporters,
 * sidecars, janitors — until a module claims them.
 */
const MODULE_SOURCES: Record<string, ReleaseSource> = Object.assign(
  {},
  ...Object.values(
    import.meta.glob<Record<string, ReleaseSource>>('../../modules/*/releases.ts', {
      eager: true,
      import: 'releases',
    }),
  ),
)

export const RELEASE_SOURCES: Record<string, ReleaseSource> = {
  // ── the household ──────────────────────────────────────────────────────
  'immich-redis': { repo: 'valkey-io/valkey' },
  'immich-postgres': { repo: 'immich-app/base-images', opts: { notesWhenUnknown: true } },
  'nextcloud-redis': { repo: 'redis/redis', opts: { notesWhenUnknown: true } },

  // ── the edge ───────────────────────────────────────────────────────────
  // Only searxng is left here: it fronts LiteLLM's web search, not a route in
  // or out, so it waits for the AI module to claim it.
  searxng: { repo: 'searxng/searxng', branch: 'master' },

  // ── the watchers ───────────────────────────────────────────────────────
  'node-exporter': { repo: 'prometheus/node_exporter' },
  'intel-gpu-exporter': { repo: 'clambin/intel-gpu-exporter' },

  // ── apps, games ────────────────────────────────────────────────────────
  zot: { repo: 'project-zot/zot' },

  // Deliberately absent, and each for a reason rather than an oversight:
  //   factorio      — ofsm wraps the game; the version that matters is
  //                   Factorio's own, which the Gaming tab reads from the
  //                   wiki changelog because there is no GitHub release for it.
  //   minecraft-monitor — same shape, and its base states no version at all.
}

/**
 * Where to read this container's notes, or null if nowhere trustworthy.
 *
 * The label fallback is deliberately narrow: only `github.com/<owner>/<repo>`,
 * and only when nothing is curated. A source URL pointing anywhere else is a
 * repo this app has no reader for, and one pointing at a packaging repo is
 * exactly what the curated table exists to override.
 */
export async function releaseSourceFor(container: string): Promise<ReleaseSource | null> {
  const curated = MODULE_SOURCES[container] ?? RELEASE_SOURCES[container]
  if (curated !== undefined) return curated

  const { source } = await imageLabels(container)
  if (source === null) return null

  const m = /^https?:\/\/github\.com\/([^/]+\/[^/#?]+?)(?:\.git)?\/?$/.exec(source)
  if (m?.[1] === undefined) return null

  // `notesWhenUnknown`, because an uncurated container is one whose running
  // version this app has no reader for either — so the honest panel is "here
  // is what upstream has published, and we cannot say which of it you have".
  return { repo: m[1], opts: { notesWhenUnknown: true } }
}
