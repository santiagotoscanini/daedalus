import { LogBoard, type LogNeighbour } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { Board, BoardGrid, Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { MediaData } from '../data'
import {
  CELL_MONO,
  CELL_NAME,
  CELL_QUIET,
  FOOT,
  HealthChecks,
  HealthLine,
  healthFailing,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableSection,
} from './shared'

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
    note: 'Indexers behind a Cloudflare challenge are searched through this. When one of them starts failing every query while the others are fine, this log says whether the challenge was refused or the browser never started. Prowlarr itself only records that the request timed out.',
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
            them. Nothing here downloads anything. It finds the release and hands back a link.
          </>
        }
        actions={<Open name="Prowlarr" host="prowlarr" />}
      />

      <HealthLine checks={d.health} reachable={reachable} />

      <BoardGrid>
        {/* Only when something is failing: a passing set of checks is the
            line under the head, not a board. */}
        {healthFailing(d.health, reachable) && (
          <Board title="What it says is wrong" icon="warn" span={12}>
            <HealthChecks checks={d.health} reachable={reachable} />
          </Board>
        )}

        <TableSection
          title="Indexers"
          note={
            <>
              {num(d.counts.enabled)} enabled
              {(d.counts.disabled ?? 0) > 0 && ` · ${num(d.counts.disabled)} off`}
            </>
          }
          foot={
            <p className={FOOT}>
              Queries are the bar, because that is what the *arrs spend. Grabs beside it is the
              yield: an indexer with thousands of queries and no grabs is being searched and never
              has the answer, which is a reason to turn it off rather than a fault.
            </p>
          }
        >
          <ul className={TABLE} aria-label="Indexers">
            <li aria-hidden="true" className={cn(IDX_GRID, TABLE_HEAD)}>
              <span>Indexer</span>
              <span className={WIDE}>Protocol</span>
              <span className="text-right">Queries</span>
              <span className={cn(MID, 'text-right')}>Grabs</span>
              <span className={cn(WIDE, 'text-right')}>Response, ms</span>
              <span className={cn(MID, 'text-right')}>Failed</span>
            </li>
            {d.indexers.length === 0 ? (
              <li className={TABLE_EMPTY}>No indexer statistics.</li>
            ) : (
              d.indexers.map((i) => <IndexerRow key={i.name} i={i} max={maxQueries} />)
            )}
          </ul>
        </TableSection>

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

/* Name, protocol, then the counts read across. Protocol repeats down the
   column (nearly everything is a torrent indexer), so it is quiet and goes
   first; response time with it. */
const IDX_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1.4fr)_5rem_minmax(0,1.6fr)_4rem_6rem_4rem]',
  '@max-[52rem]/table:grid-cols-[minmax(0,1.4fr)_minmax(0,1.6fr)_4rem_4rem]',
  '@max-[34rem]/table:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]',
)
const WIDE = '@max-[52rem]/table:hidden'
const MID = '@max-[34rem]/table:hidden'
const NUM = cn(CELL_QUIET, 'text-right')

const BAR = 'block h-1 min-w-8 flex-1 overflow-hidden rounded-full bg-foreground/[0.08]'
const BAR_FILL =
  'block h-full origin-left animate-[bar-grow_600ms_cubic-bezier(0.2,0.9,0.2,1)_both] rounded-full bg-info opacity-85 motion-reduce:animate-none'

type Indexer = Extract<MediaData, { tab: 'indexer' }>['indexers'][number]

/**
 * One indexer. Disabled is muted ("deliberately off", which explains the
 * silence); failing — over a quarter of its queries — is the one warning.
 */
function IndexerRow({ i, max }: { i: Indexer; max: number }) {
  const failing = i.queries > 0 && i.failedQueries / i.queries > 0.25
  return (
    <li className={cn(IDX_GRID, TABLE_ROW, !i.enabled && 'opacity-60')}>
      <span className="flex min-w-0 items-center gap-2">
        <span className={CELL_NAME}>{i.name}</span>
        {!i.enabled && <Chip>disabled</Chip>}
        {failing && (
          <Chip
            tone="warn"
            title={`${String(i.failedQueries)} of ${String(i.queries)} queries failed`}
          >
            failing
          </Chip>
        )}
      </span>
      <span className={cn(CELL_MONO, WIDE)}>{i.protocol}</span>
      <span className="flex min-w-0 items-center gap-3">
        <span className={BAR}>
          <span
            className={BAR_FILL}
            style={{ width: `${String(Math.max(1.5, (i.queries / max) * 100))}%` }}
          />
        </span>
        <span className="w-12 flex-none text-right text-foreground tabular-nums">
          {num(i.queries)}
        </span>
      </span>
      <span className={cn(NUM, MID)}>{num(i.grabs)}</span>
      <span className={cn(NUM, WIDE)}>{i.responseMs === null ? '' : num(i.responseMs)}</span>
      <span className={cn(NUM, MID, i.failedQueries > 0 && 'text-danger')}>
        {i.failedQueries > 0 ? num(i.failedQueries) : ''}
      </span>
    </li>
  )
}
