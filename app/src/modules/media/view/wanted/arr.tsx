// Wanted › Sonarr and Radarr: one page, two apps.

import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../../components/service-head'
import { Board, BoardGrid, Facts, Progress } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { bytes, daysAgo, inDays, num } from '../../../../lib/format'
import {
  EMPTY,
  FEED,
  FEED_EVENT,
  FEED_ROW,
  FEED_TITLE,
  FEED_WHEN,
  FOOT,
  HealthChecks,
  LIST,
  NOTE,
  SUB,
  TRANSFER_HEAD,
  TRANSFER_META,
  TRANSFER_NAME,
  TRANSFER_ROW,
  TRANSFERS,
} from '../shared'
import type { Wanted } from './shared'
import { WANTED_NEIGHBOURS } from './shared'

/* What is coming: a title with its episode under it, and a date on the right.
   The date is brand-coloured because it is the reading; one already on disk
   goes grey, since there is nothing left to wait for. */
const UPNEXT = `${LIST} gap-[0.3rem]`
const UPNEXT_ROW = 'flex items-baseline justify-between gap-[0.7rem] text-[0.82rem]'
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
    lede: 'Watches series for new episodes, asks Prowlarr where to find them, and hands what it finds to a downloader. What arrives is renamed into /s2/tv and Jellyfin picks it up.',
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
  const copy = ARR_COPY[d.app]
  const { counts } = d
  const reachable = d.version !== null

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

      <BoardGrid>
        <Board
          title="What it says is wrong"
          icon="warn"
          span={8}
          aside={<span className={NOTE}>its own health checks</span>}
        >
          <HealthChecks checks={d.health} reachable={reachable} />
        </Board>

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
                tone="info"
              />
              <p className={FOOT}>
                {bytes(disk.freeBytes)} free of {bytes(disk.totalBytes)}
              </p>
            </div>
          ))}
        </Board>

        <Board
          title="Queue"
          icon="down"
          span={8}
          aside={
            <span className={NOTE}>
              {num(counts.queued)} item{counts.queued === 1 ? '' : 's'}
            </span>
          }
        >
          {d.queue.length === 0 ? (
            <p className={EMPTY}>
              Nothing in the queue. Completed downloads are removed once imported.
            </p>
          ) : (
            <ul className={TRANSFERS}>
              {d.queue.map((q, i) => (
                <li key={`${q.title}-${String(i)}`} className={TRANSFER_ROW}>
                  <div className={TRANSFER_HEAD}>
                    <span className={TRANSFER_NAME} title={q.title}>
                      {q.title}
                    </span>
                    <span className={TRANSFER_META}>
                      {q.pct.toFixed(0)}% of {bytes(q.sizeBytes)}
                      {q.issue !== null && <span className="text-danger"> · {q.issue}</span>}
                    </span>
                  </div>
                  <Progress
                    pct={q.pct}
                    tone={q.issue !== null ? 'bad' : 'accent'}
                    active={q.issue === null && q.pct < 100}
                  />
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            An item stuck at 100% with a note against it is the failure this panel exists for: the
            download finished and the import did not, so nothing is moving and nothing is wrong
            anywhere else.
          </p>
        </Board>

        <Board title={copy.upcoming} icon="clock" span={4}>
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
                    className={cn(UPNEXT_WHEN, u.have ? 'text-muted-foreground' : 'text-primary')}
                  >
                    {u.have ? 'have it' : inDays(u.inDays)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Board>

        <Board title="Lately" icon="≋" span={12}>
          {d.history.length === 0 ? (
            <p className={EMPTY}>no recorded activity</p>
          ) : (
            <ul className={FEED}>
              {d.history.map((h, i) => (
                <li key={`${h.title}-${String(i)}`} className={FEED_ROW}>
                  <span className={cn(FEED_EVENT, EVENT_INK[h.tone])}>{h.event}</span>
                  <span className={FEED_TITLE} title={h.title}>
                    {h.title}
                  </span>
                  <span className={FEED_WHEN}>{daysAgo(h.ageDays)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            Only failures are coloured. A grab and an import are the machine working, and colouring
            those would bury the two events that mean somebody has to look.
          </p>
        </Board>

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
