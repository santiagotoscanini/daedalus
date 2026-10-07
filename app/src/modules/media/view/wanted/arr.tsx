// Wanted › Sonarr and Radarr: one page, two apps.

import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../../components/service-head'
import { Board, BoardGrid, Facts, Progress } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { bytes, daysAgo, inDays, num } from '../../../../lib/format'
import {
  CAPTION,
  CELL_QUIET,
  EMPTY,
  FOOT,
  HealthChecks,
  HealthLine,
  healthFailing,
  LIST,
  NOTE,
  QueueTable,
  SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableSection,
} from '../shared'
import type { Wanted } from './shared'
import { WANTED_NEIGHBOURS } from './shared'

/* What is coming: a title with its episode under it, and a date on the right.
   The date is in full ink because it is the reading; one already on disk
   goes grey, since there is nothing left to wait for. */
const UPNEXT = LIST
const UPNEXT_ROW =
  'flex items-baseline justify-between gap-3 border-hairline border-t py-2 text-[0.8125rem] first:border-t-0 first:pt-0'
const UPNEXT_TITLE = 'min-w-0 truncate'
const UPNEXT_SUB = 'block truncate text-[0.72rem] text-muted-foreground not-italic'
const UPNEXT_WHEN = 'whitespace-nowrap text-[0.75rem]'

/* Only failures are coloured in the feed; a tone per event, as literal strings
   so the scanner sees them. */
const EVENT_INK: Record<Wanted['sonarr']['history'][number]['tone'], string> = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  muted: '',
}

/**
 * The words that differ between Sonarr and Radarr, and nothing else.
 *
 * Everything else on this page is identical because the software is identical —
 * see the note on `ArrData`. Keeping the differences in one table rather than in
 * two components is what stops them becoming two pages that drift.
 */
const ARR_COPY = {
  sonarr: {
    name: 'Sonarr',
    logo: '/icon-sonarr.svg',
    unit: 'Series',
    lede: 'Watches series for new episodes, asks Prowlarr where to find them and hands them to a downloader. Arrivals are renamed into /s2/tv for Jellyfin.',
    upcoming: 'Airing next',
  },
  radarr: {
    name: 'Radarr',
    logo: '/icon-radarr.svg',
    unit: 'Movies',
    lede: 'The same program as Sonarr, pointed at films. Same indexers, same downloaders, same folder. The difference is that a film has a release date rather than a schedule.',
    upcoming: 'Releasing next',
  },
} as const

export function ArrPage({ d }: { d: Wanted['sonarr'] }) {
  const f = arrFacts({ d })
  const { copy, reachable } = f

  return (
    <>
      <ServiceHead
        logo={copy.logo}
        name={copy.name}
        version={d.version}
        versionNote="reported by the app"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/v3/system/status')}
        lede={copy.lede}
        actions={<Open name={copy.name} host={d.app} />}
      />

      <HealthLine checks={d.health} reachable={reachable} />

      <BoardGrid>
        {/* Its own health checks get a board only while one is failing; a
            passing set is the quiet line under the head. */}
        {healthFailing(d.health, reachable) && (
          <Board
            title="What it says is wrong"
            icon="warn"
            span={12}
            aside={<span className={NOTE}>its own health checks</span>}
          >
            <HealthChecks checks={d.health} reachable={reachable} />
          </Board>
        )}

        <TheLibraryBoard f={f} />

        <Panel f={f} />

        <QueueTableSection f={f} />

        <LatelyTable f={f} />

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ container: d.app }}
          title={`${copy.name} logs`}
          neighbours={WANTED_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function arrFacts({ d }: { d: Wanted['sonarr'] }) {
  const copy = ARR_COPY[d.app]
  const { counts } = d
  const reachable = d.version !== null
  return { d, copy, counts, reachable }
}

type ArrFacts = NonNullable<ReturnType<typeof arrFacts>>

function TheLibraryBoard({ f }: { f: ArrFacts }) {
  const { d, copy, counts } = f
  return (
    <Board title="The library" icon="grid" span={4}>
      <Facts
        rows={[
          { k: copy.unit, v: num(counts.library) },
          { k: 'Monitored', v: num(counts.monitored) },
          { k: 'On disk', v: bytes(counts.sizeBytes) },
          {
            k: 'Still wanted',
            v:
              (counts.wanted ?? 0) === 0 ? (
                num(counts.wanted)
              ) : (
                <span className="text-warning">{num(counts.wanted)}</span>
              ),
          },
        ]}
      />
      {d.disk.map((disk) => (
        <div key={disk.path}>
          <h4 className={SUB}>{disk.path}</h4>
          <Progress
            pct={
              disk.totalBytes > 0
                ? ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100
                : null
            }
            tone="muted"
          />
          <p className={CAPTION}>
            {bytes(disk.freeBytes)} free of {bytes(disk.totalBytes)}
          </p>
        </div>
      ))}
    </Board>
  )
}

function Panel({ f }: { f: ArrFacts }) {
  const { d, copy } = f
  return (
    <Board title={copy.upcoming} icon="clock" span={8}>
      {d.upcoming.length === 0 ? (
        <p className={EMPTY}>Nothing scheduled in the next fortnight.</p>
      ) : (
        <ul className={UPNEXT}>
          {d.upcoming.map((u, i) => (
            <li key={`${u.title}-${String(i)}`} className={UPNEXT_ROW}>
              <span className={UPNEXT_TITLE} title={u.sub ?? u.title}>
                {u.title}
                {u.sub !== null && <em className={UPNEXT_SUB}>{u.sub}</em>}
              </span>
              <span
                className={cn(UPNEXT_WHEN, u.have ? 'text-muted-foreground' : 'text-foreground')}
              >
                {u.have ? 'have it' : inDays(u.inDays)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Board>
  )
}

function QueueTableSection({ f }: { f: ArrFacts }) {
  const { d, counts } = f
  return (
    <TableSection
      title="Queue"
      note={`${num(counts.queued)} item${counts.queued === 1 ? '' : 's'}`}
      foot={
        <p className={FOOT}>
          An item stuck at 100% with a note against it is the failure this table exists for: the
          download finished and the import did not, so nothing is moving and nothing is wrong
          anywhere else.
        </p>
      }
    >
      <QueueTable
        label={`${f.copy.name} queue`}
        detail="Size · issue"
        empty="Nothing in the queue. Completed downloads are removed once imported."
        rows={d.queue.map((q, i) => ({
          key: `${q.title}-${String(i)}`,
          name: q.title,
          pct: q.pct,
          tone: q.issue !== null ? 'bad' : 'muted',
          active: q.issue === null && q.pct < 100,
          detail: (
            <>
              {bytes(q.sizeBytes)}
              {q.issue !== null && <span className="text-danger"> · {q.issue}</span>}
            </>
          ),
        }))}
      />
    </TableSection>
  )
}

/* Event, title, when. The event is a fixed column because its vocabulary is
   small and repeated, so a reader scanning for one is scanning one column. */
const FEED_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[8rem_minmax(0,1fr)_5.5rem]',
  '@max-[34rem]/table:grid-cols-[minmax(0,1fr)_5.5rem]',
)

function LatelyTable({ f }: { f: ArrFacts }) {
  const { d } = f
  return (
    <TableSection
      title="Lately"
      foot={
        <p className={FOOT}>
          Only failures are coloured. A grab and an import are the machine working, and colouring
          those would bury the two events that mean somebody has to look.
        </p>
      }
    >
      <ul className={TABLE} aria-label="Lately">
        {d.history.length > 0 && (
          <li aria-hidden="true" className={cn(FEED_GRID, TABLE_HEAD)}>
            <span className="@max-[34rem]/table:hidden">Event</span>
            <span>Title</span>
            <span className="text-right">When</span>
          </li>
        )}
        {d.history.length === 0 ? (
          <li className={TABLE_EMPTY}>No recorded activity.</li>
        ) : (
          d.history.map((h, i) => (
            <li key={`${h.title}-${String(i)}`} className={cn(FEED_GRID, TABLE_ROW)}>
              <span
                className={cn(
                  CELL_QUIET,
                  'first-letter:uppercase @max-[34rem]/table:hidden',
                  EVENT_INK[h.tone],
                )}
              >
                {h.event}
              </span>
              <span className="truncate text-foreground" title={h.title}>
                {h.title}
              </span>
              <span className={cn(CELL_QUIET, 'whitespace-nowrap text-right')}>
                {daysAgo(h.ageDays)}
              </span>
            </li>
          ))
        )}
      </ul>
    </TableSection>
  )
}
