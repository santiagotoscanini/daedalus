import type { MediaData } from '../../../lib/dashboard/categories/media'
import { num } from '../../../lib/format'
import { LogBoard, type LogNeighbour } from '../../logs'
import { Changelog } from '../../release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../service-head'
import { Board, BoardGrid, RankRow } from '../../viz'
import { HealthChecks } from './shared'

/* ── Indexer: Prowlarr ────────────────────────────────────────────────── */

/**
 * flaresolverr has no page anywhere and no API this box can reach — it lives
 * inside gluetun's netns with no published port — so its log is the only thing
 * that can be said about it, and Prowlarr is the only tab where it means
 * anything.
 */
const PROWLARR_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { container: 'flaresolverr' },
    label: 'FlareSolverr',
    role: 'the browser that answers Cloudflare challenges',
    note: 'Indexers behind a Cloudflare challenge are searched through this. When one of them starts failing every query while the others are fine, this log says whether the challenge was refused or the browser never started — Prowlarr itself only records that the request timed out.',
  },
]

export function ProwlarrView({ d }: { d: Extract<MediaData, { tab: 'indexer' }> }) {
  const maxQueries = Math.max(...d.indexers.map((i) => i.queries), 1)
  const reachable = d.version !== null

  return (
    <>
      <ServiceHead
        logo="/icon-prowlarr.svg"
        name="Prowlarr"
        version={d.version}
        versionNote="reported by the app"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/v1/system/status')}
        lede={
          <>
            One place to configure indexers, and one place for Sonarr, Radarr and Bazarr to search
            them. Nothing here downloads anything — it finds the release and hands back a link.
          </>
        }
        actions={<Open name="Prowlarr" host="prowlarr" />}
      />

      <BoardGrid>
        <Board
          title="Indexers"
          icon="⌕"
          span={12}
          aside={
            <span className="board-note">
              {num(d.counts.enabled)} enabled
              {(d.counts.disabled ?? 0) > 0 && ` · ${num(d.counts.disabled)} off`}
            </span>
          }
        >
          {d.indexers.length === 0 ? (
            <p className="viz-empty">no indexer statistics</p>
          ) : (
            <ul className="ranks">
              {d.indexers.map((i) => (
                <RankRow
                  key={i.name}
                  name={i.name}
                  badges={[
                    ...(i.enabled ? [] : [{ text: 'disabled', tone: 'muted' as const }]),
                    ...(i.queries > 0 && i.failedQueries / i.queries > 0.25
                      ? [
                          {
                            text: 'failing',
                            tone: 'warn' as const,
                            why: `${String(i.failedQueries)} of ${String(i.queries)} queries failed`,
                          },
                        ]
                      : []),
                  ]}
                  value={i.queries}
                  max={maxQueries}
                  meta={
                    <>
                      <span>{num(i.grabs)} grabs</span>
                      {i.responseMs !== null && <span>{num(i.responseMs)} ms</span>}
                      {i.failedQueries > 0 && (
                        <span className="bad-text">{num(i.failedQueries)} failed</span>
                      )}
                      <span className="mono">{i.protocol}</span>
                    </>
                  }
                />
              ))}
            </ul>
          )}
          <p className="board-foot">
            Queries are the bar, because that is what the *arrs actually spend. Grabs beside it is
            the yield: an indexer with thousands of queries and no grabs is being searched and never
            has the answer, which is a reason to turn it off rather than a fault.
          </p>
        </Board>

        <Board title="What it says is wrong" icon="warn" span={12}>
          <HealthChecks checks={d.health} reachable={reachable} />
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ container: 'prowlarr' }}
          title="Prowlarr logs"
          neighbours={PROWLARR_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}
