import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { Board, BoardGrid, Chip, Progress, Pulse, Ring, Trend } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, daysAgo, num } from '../../../lib/format'
import type { MediaData } from '../data'
import {
  CELL_NAME,
  CELL_QUIET,
  CELL_SUB,
  EMPTY,
  FOOT,
  MONO,
  NOTE,
  PHONE_SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableSection,
  WRAP_PHONE,
} from './shared'

/* ── Jellyfin ─────────────────────────────────────────────────────────── */

/** Idle longer than this and an account is worth noticing rather than listing. */
const STALE_DAYS = 60

export function JellyfinView({ d }: { d: Extract<MediaData, { tab: 'jellyfin' }> }) {
  const f = jellyfinFacts({ d })

  return (
    <>
      <ServiceHead
        logo="/icon-jellyfin.svg"
        name="Jellyfin"
        version={d.version}
        versionNote="reported by the server"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /System/Info')}
        lede={
          <>
            Where everything on this page ends up. Streams from <span className={MONO}>/s2/tv</span>
            , transcodes on the iGPU, and sits outside the VPN so home playback stays at home.
          </>
        }
        actions={<Open name="Jellyfin" host="jellyfin" />}
      />

      <BoardGrid>
        <PlayingNow f={f} />

        <LibraryBoard f={f} />

        <Changelog
          gap={d.gap}
          span={12}
          aside={
            d.pendingRestart ? (
              <span className={cn(NOTE, 'text-warning')}>restart pending</span>
            ) : (
              <span className={NOTE}>github</span>
            )
          }
        />

        <JellyfinLogsBoard />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function jellyfinFacts({ d }: { d: Extract<MediaData, { tab: 'jellyfin' }> }) {
  const { library, counts } = d
  const total =
    library.usedBytes !== null && library.freeBytes !== null
      ? library.usedBytes + library.freeBytes
      : null
  const transcoding = d.playing.filter((s) => s.method === 'Transcode').length
  return { d, library, counts, total, transcoding }
}

type JellyfinFacts = NonNullable<ReturnType<typeof jellyfinFacts>>

/* Title, who, on what, how, and how far. The method is the column that
   matters — Transcode vs DirectPlay is the difference between a quiet box and
   a pegged iGPU — so it alone is coloured, and only when it is a transcode. */
const PLAY_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_minmax(0,1fr)_6.5rem_minmax(0,1.2fr)]',
  '@max-[52rem]/table:grid-cols-[minmax(0,2fr)_minmax(0,0.8fr)_6.5rem]',
  '@max-[38rem]/table:grid-cols-[minmax(0,1fr)_6.5rem]',
)
const WIDE = '@max-[52rem]/table:hidden'
const MID = '@max-[38rem]/table:hidden'

/** Who is watching what, right now: a table that is one quiet row most of the day. */
function PlayingNow({ f }: { f: JellyfinFacts }) {
  const { d, transcoding } = f
  return (
    <TableSection
      title="Playing now"
      aside={transcoding === 0 ? undefined : `${num(transcoding)} transcoding`}
      foot={
        <p className={FOOT}>
          Only sessions actually playing something. Every poller that has ever asked Jellyfin a
          question holds an idle session for a while afterwards, so the raw list reports an audience
          that is not in the room. Jellyfin is the one media container deliberately outside the VPN,
          so playing something at home does not go out through Switzerland and back.
        </p>
      }
    >
      <ul className={TABLE} aria-label="Playing now">
        {/* No column labels over an empty room: one quiet row is the whole answer. */}
        {d.playing.length > 0 && (
          <li aria-hidden="true" className={cn(PLAY_GRID, TABLE_HEAD)}>
            <span>Title</span>
            <span className={MID}>Who</span>
            <span className={WIDE}>Device</span>
            <span>Method</span>
            <span className={WIDE}>Progress</span>
          </li>
        )}
        {d.playing.length === 0 ? (
          <li className={cn(TABLE_EMPTY, 'py-6')}>Nobody is watching anything.</li>
        ) : (
          d.playing.map((s, i) => (
            <li key={`${s.user}-${String(i)}`} className={cn(PLAY_GRID, TABLE_ROW)}>
              <span className="flex min-w-0 items-center gap-2">
                <Pulse on={!s.paused} tone="ok" />
                <span className="min-w-0">
                  <span className={cn(CELL_NAME, WRAP_PHONE, 'block')}>{s.title}</span>
                  {s.sub !== null && <span className={cn(CELL_SUB, 'block')}>{s.sub}</span>}
                  <span className={PHONE_SUB}>
                    {[s.user, s.device].filter((x) => x !== null && x !== '').join(' · ')}
                  </span>
                  <span className="mt-1.5 hidden @max-[38rem]/table:block">
                    <Progress pct={s.pct} tone="muted" active={!s.paused} />
                  </span>
                </span>
              </span>
              <span className={cn(CELL_QUIET, MID, 'truncate text-foreground')}>{s.user}</span>
              <span className={cn(CELL_QUIET, WIDE, 'truncate')}>{s.device ?? ''}</span>
              <span className="flex items-center gap-1.5">
                {s.method !== null &&
                  (s.method === 'Transcode' ? (
                    <Chip tone="warn">{s.method}</Chip>
                  ) : (
                    <span className={CELL_QUIET}>{s.method}</span>
                  ))}
                {s.paused && <Chip>paused</Chip>}
              </span>
              <span className={WIDE}>
                <Progress pct={s.pct} tone="muted" active={!s.paused} />
              </span>
            </li>
          ))
        )}
      </ul>
    </TableSection>
  )
}

/**
 * The library: how much of the pool it fills, what it holds, how it grows —
 * and who watches. The people were a board of their own holding one row
 * beside a changelog, both near-empty; they are the library's audience, so
 * they sit under it on a hairline.
 *
 * Below 25rem of board the ring stacks above a 2x2 grid of the counts, so
 * neither the donut shrinks to a coin nor the counts line up lopsided.
 */
function LibraryBoard({ f }: { f: JellyfinFacts }) {
  const { d, library, counts, total } = f
  const stats = [
    { k: 'Movies', v: num(counts.movies) },
    { k: 'Series', v: num(counts.series) },
    { k: 'Episodes', v: num(counts.episodes) },
    { k: 'Free on pool', v: bytes(library.freeBytes) },
  ]
  return (
    <Board
      title="Library"
      icon="grid"
      span={12}
      aside={
        <span className={NOTE}>
          {num(d.people.length)} {d.people.length === 1 ? 'account' : 'accounts'}
        </span>
      }
    >
      <div className="grid grid-cols-[auto_minmax(0,1fr)_minmax(0,1.3fr)] items-center gap-x-10 gap-y-5 @max-[56rem]/board:grid-cols-[auto_minmax(0,1fr)] @max-[25rem]/board:grid-cols-1 @max-[25rem]/board:justify-items-center">
        <Ring
          pct={
            total === null || library.usedBytes === null ? null : (library.usedBytes / total) * 100
          }
          value={bytes(library.usedBytes)}
          label="/s2/tv"
          tone="muted"
        />
        <dl className="m-0 grid w-full grid-cols-2 gap-x-6 gap-y-3 @max-[25rem]/board:max-w-[18rem]">
          {stats.map((s) => (
            <div key={s.k} className="flex min-w-0 flex-col gap-[0.05rem]">
              <dt className="text-[0.75rem] text-muted-foreground">{s.k}</dt>
              <dd className="m-0 text-[0.9375rem] tabular-nums [font-weight:520]">{s.v}</dd>
            </div>
          ))}
        </dl>
        <div className="min-w-0 @max-[56rem]/board:col-span-2 @max-[25rem]/board:col-span-1 @max-[25rem]/board:w-full">
          <p className="m-0 mb-1.5 text-[0.75rem] text-muted-foreground">Growth, 30 days</p>
          <Trend values={library.growth} tone="muted" height={48} />
        </div>
      </div>

      <div className="border-hairline border-t pt-3">
        <p className="m-0 mb-1.5 text-[0.75rem] text-muted-foreground">Who watches</p>
        {d.people.length === 0 ? (
          <p className={EMPTY}>could not read the user list</p>
        ) : (
          <ul className={'m-0 flex list-none flex-wrap gap-x-6 gap-y-1 p-0'}>
            {d.people.map((p) => (
              <li key={p.name} className="flex items-baseline gap-2 text-[0.8125rem]">
                <span>{p.name}</span>
                <span
                  className={cn(
                    'whitespace-nowrap text-[0.75rem] text-muted-foreground',
                    p.lastSeenDays !== null && p.lastSeenDays > STALE_DAYS && 'opacity-55',
                  )}
                >
                  {daysAgo(p.lastSeenDays)}
                </span>
              </li>
            ))}
          </ul>
        )}
        <p className={FOOT}>
          Last activity, not last login. A client that stays signed in reports the second one once
          and never again, which is why an account in daily use can show a login from May.
        </p>
      </div>
    </Board>
  )
}

function JellyfinLogsBoard() {
  return (
    <LogBoard
      source={{ container: 'jellyfin' }}
      title="Jellyfin logs"
      neighbours={[
        {
          source: { container: 'intel-gpu-exporter' },
          label: 'intel-gpu-exporter',
          role: 'what the iGPU is actually doing',
          note: 'The only reader of the render node Jellyfin transcodes on, and the only container on this box with no page of its own. Its metrics (gpumon_engine_usage, gpumon_power) are scraped and nothing here draws them yet. When a transcode is slow and Jellyfin’s own log says only that ffmpeg took a while, this is where "was the GPU busy or was it not being used at all" is answered. i915 is force-probed via a kernel param; a driver that failed to bind shows up here first.',
        },
      ]}
    />
  )
}
