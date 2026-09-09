import { useState } from 'react'
import { cn } from '../../../lib/cn'
import type { MediaData } from '../../../lib/dashboard/categories/media'
import { bytes, DASH, num } from '../../../lib/format'
import { LogBoard, type LogNeighbour } from '../../logs'
import { Changelog } from '../../release-notes'
import { compareOf, Open, ServiceHead, SOURCE_NOTE, verdictOf } from '../../service-head'
import { Board, BoardGrid, Chip, Facts, Measures, Progress, RankRow } from '../../viz'
import {
  ago,
  CHECK_ROW,
  EMPTY,
  FEED,
  FEED_EVENT,
  FEED_ROW,
  FEED_TITLE,
  FEED_WHEN,
  FOOT,
  HealthChecks,
  inDays,
  LIST,
  MONO,
  NOTE,
  PROV,
  PROVS,
  ServiceBar,
  TRANSFER_HEAD,
  TRANSFER_META,
  TRANSFER_NAME,
  TRANSFER_ROW,
  TRANSFERS,
  tone,
  VERSION_SNAPSHOT,
} from './shared'

/* ── Wanted: Seerr, Sonarr, Radarr, Recyclarr, Bazarr ─────────────────── */

/**
 * scraparr is what turns the *arrs into prometheus series, and it has no page
 * anywhere: it serves only /metrics. It belongs under these three because a
 * gap in the *arr graphs on the Monitoring page is nearly always this
 * container having stopped, not the *arr.
 */
const WANTED_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { container: 'scraparr' },
    label: 'Scraparr',
    role: 'the exporter behind the *arr graphs',
    note: 'Polls Sonarr, Radarr, Prowlarr and Bazarr on a timer and republishes what they say as prometheus metrics. Nothing on this tab reads it; every number here comes from the *arrs directly. The dashboards on the Monitoring page do, so a flat line there starts here. Expect periodic “scrape failed” and “No data found” errors: those four are dialled at a rootless-published host port, where a new connection occasionally hangs ~10.5s, and scraparr gives up at a hardcoded 10 with no retry. The scrape after it succeeds and the previous value is kept, so the metrics stay correct, but scraparr_services_up dips while it happens.',
  },
]

/* Status first, because it is the column that decides whether the row needs
   you. The title takes the slack; requester and age are fixed so the eye can
   run down them. Below 34rem the five stack. */
const REQS = `${LIST} gap-[0.2rem]`
const REQ =
  'grid grid-cols-[5.6rem_minmax(0,1fr)_3.6rem_6rem_5rem] items-center gap-[0.6rem] py-[0.22rem] text-[0.82rem] max-[34rem]:grid-cols-[minmax(0,1fr)] max-[34rem]:gap-[0.15rem]'
const REQ_SIDE = 'text-[0.75rem] text-muted-foreground'
const REQ_WHEN = `${REQ_SIDE} text-right max-[34rem]:text-left`

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

/** A heading inside a board's body. */
const SUB =
  'mx-0 mt-[0.35rem] -mb-[0.2rem] text-[0.73rem] font-[550] tracking-normal text-muted-foreground'

type Wanted = Extract<MediaData, { tab: 'wanted' }>

export function WantedView({ d }: { d: Wanted }) {
  // Seerr first: it is where a title enters the system, and the other two are
  // what happens to it afterwards. Reading them in that order is reading them
  // in the order the work actually flows.
  const [who, setWho] = useState<'seerr' | 'sonarr' | 'radarr' | 'recyclarr' | 'bazarr'>('seerr')

  return (
    <>
      <ServiceBar
        value={who}
        onChange={setWho}
        options={[
          { value: 'seerr', label: 'Seerr', dot: tone(d.seerr.version !== null) },
          { value: 'sonarr', label: 'Sonarr', dot: tone(d.sonarr.version !== null) },
          { value: 'radarr', label: 'Radarr', dot: tone(d.radarr.version !== null) },
          // Recyclarr sits with the two it configures rather than with the
          // cleaners. Its dot is its last run, not its reachability — it is
          // not a running process between runs, so there is nothing to reach.
          {
            value: 'recyclarr',
            label: 'Recyclarr',
            dot: d.recyclarr.lastRun === null ? null : tone(d.recyclarr.lastRun.ok),
          },
          { value: 'bazarr', label: 'Bazarr', dot: tone(d.bazarr.version !== null) },
        ]}
      />

      {who === 'seerr' ? (
        <SeerrPage d={d.seerr} />
      ) : who === 'recyclarr' ? (
        <RecyclarrPage d={d.recyclarr} />
      ) : who === 'bazarr' ? (
        <BazarrPage d={d.bazarr} />
      ) : (
        <ArrPage d={who === 'sonarr' ? d.sonarr : d.radarr} />
      )}
    </>
  )
}

function SeerrPage({ d }: { d: Wanted['seerr'] }) {
  const { counts } = d
  const maxRequests = Math.max(...d.people.map((p) => p.requests), 1)

  return (
    <>
      <ServiceHead
        logo="/icon-seerr.svg"
        name="Seerr"
        version={d.version}
        versionNote="reported by the app"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/v1/status')}
        lede={
          <>
            The front door. Somebody asks for a film or a series here, and if it is approved Seerr
            hands it straight to Radarr or Sonarr.
          </>
        }
        actions={<Open name="Seerr" host="seerr" />}
      />

      <BoardGrid>
        <Board
          title="Recent requests"
          icon="✧"
          span={8}
          aside={<span className={NOTE}>{num(counts.total)} all time</span>}
        >
          {d.requests.length === 0 ? (
            <p className={EMPTY}>Nothing has been requested.</p>
          ) : (
            <ul className={REQS}>
              {d.requests.map((r, i) => (
                <li key={`${r.title}-${String(i)}`} className={REQ}>
                  <Chip tone={r.tone}>{r.status}</Chip>
                  <span className="truncate">{r.title}</span>
                  <span className={REQ_SIDE}>{r.kind === 'tv' ? 'series' : 'film'}</span>
                  <span className={REQ_SIDE}>{r.by}</span>
                  <span className={REQ_WHEN}>{ago(r.ageDays)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            Titles are looked up per request: a request record carries a TMDB id and nothing else,
            so Seerr resolves the name the same way its own interface does.
          </p>
        </Board>

        <Board title="Where they are" icon="clock" span={4}>
          <Measures
            items={[
              {
                k: 'Pending',
                v: num(counts.pending),
                tone: (counts.pending ?? 0) > 0 ? 'warn' : undefined,
              },
              { k: 'Approved', v: num(counts.approved) },
              { k: 'Processing', v: num(counts.processing) },
              { k: 'Available', v: num(counts.available) },
              { k: 'Declined', v: num(counts.declined) },
            ]}
          />
          <p className={FOOT}>
            Pending is the only one that needs a person: everything else is either the machinery
            working or a decision already taken.
          </p>
        </Board>

        <Board title="Who asks" icon="◍" span={4}>
          {d.people.length === 0 ? (
            <p className={EMPTY}>no requests yet</p>
          ) : (
            <ul className={`${LIST} gap-[0.1rem]`}>
              {d.people.map((p) => (
                <RankRow
                  key={p.name}
                  name={p.name}
                  value={p.requests}
                  max={maxRequests}
                  meta={<span>{p.requests === 1 ? 'request' : 'requests'}</span>}
                />
              ))}
            </ul>
          )}
        </Board>

        <Changelog
          gap={d.gap}
          span={8}
          aside={
            d.selfBehind !== null && d.selfBehind > 0 ? (
              <span className={NOTE}>{num(d.selfBehind)} commits behind, it says</span>
            ) : (
              <span className={NOTE}>github</span>
            )
          }
        />

        <LogBoard
          source={{ container: 'seerr' }}
          title="Seerr logs"
          neighbours={WANTED_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
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

function ArrPage({ d }: { d: Wanted['sonarr'] }) {
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
                  <span className={FEED_WHEN}>{ago(h.ageDays)}</span>
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

/* ── Bazarr — reached from the Wanted switch above ────────────────────── */

const BAZARR_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { container: 'subgen' },
    label: 'Subgen',
    role: 'Whisper, for the subtitles nobody published',
    note: 'Registered with Bazarr as the `whisperai` provider. When an episode has no subtitles anywhere, this transcribes the audio instead. It runs on the CPU, so a single film can take a long time and the only evidence it is working is here.',
  },
]

function BazarrPage({ d }: { d: Wanted['bazarr'] }) {
  const throttled = d.providers.filter((p) => !p.ok)

  return (
    <>
      <ServiceHead
        logo="/icon-bazarr.svg"
        name="Bazarr"
        version={d.version}
        versionNote="reported by the app"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/system/status')}
        lede={
          <>
            Subtitles for what the others already downloaded. It reads Sonarr&rsquo;s and
            Radarr&rsquo;s libraries directly, so nothing here decides what exists, only what is
            missing words.
          </>
        }
        actions={<Open name="Bazarr" host="bazarr" />}
      />

      <BoardGrid>
        <Board
          title="Providers"
          icon="⛁"
          span={8}
          aside={
            throttled.length === 0 ? (
              <span className={NOTE}>all answering</span>
            ) : (
              <span className={cn(NOTE, 'text-warning')}>{num(throttled.length)} throttled</span>
            )
          }
        >
          {d.providers.length === 0 ? (
            <p className={EMPTY}>could not read the provider list</p>
          ) : (
            <ul className={PROVS}>
              {d.providers.map((p) => (
                <li key={p.name} className={PROV}>
                  <Chip tone={p.ok ? 'ok' : 'warn'}>{p.status}</Chip>
                  <span className={MONO}>{p.name}</span>
                  {p.retry !== '-' && (
                    <span className="text-[0.72rem] text-warning">retry {p.retry}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            The panel that explains a subtitle which never arrives. A throttled provider answers
            nothing and reports no error, so &ldquo;none found&rdquo; and &ldquo;we are not
            currently allowed to ask&rdquo; look identical everywhere except here.
          </p>
        </Board>

        <Board title="Still missing" icon="clock" span={4}>
          <Facts
            rows={[
              { k: 'Episodes', v: num(d.wanted.episodes) },
              { k: 'Movies', v: num(d.wanted.movies) },
              { k: 'Sees Sonarr', v: <span className={MONO}>{d.linked.sonarr ?? DASH}</span> },
              { k: 'Sees Radarr', v: <span className={MONO}>{d.linked.radarr ?? DASH}</span> },
            ]}
          />
          <p className={FOOT}>
            The two versions are Bazarr&rsquo;s own view of the *arrs it is wired to. It is a cheap
            cross-check that both connections are live, since a broken one reports zero missing
            rather than an error.
          </p>
        </Board>

        <Changelog
          gap={d.gap}
          span={12}
          aside={
            d.subgen === null ? (
              <span className={NOTE}>github</span>
            ) : (
              <span className={NOTE}>
                Subgen <span className={MONO}>{d.subgen}</span>
              </span>
            )
          }
        />

        <LogBoard
          source={{ container: 'bazarr' }}
          title="Bazarr logs"
          neighbours={BAZARR_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}

function RecyclarrPage({ d }: { d: Wanted['recyclarr'] }) {
  const recyclarr = d

  return (
    <>
      <ServiceHead
        logo="/icon-recyclarr.svg"
        name="Recyclarr"
        version={recyclarr.running.version}
        versionNote={SOURCE_NOTE[recyclarr.running.source]}
        verdict={verdictOf(recyclarr.gap)}
        compare={compareOf(
          recyclarr.gap,
          recyclarr.running.revision === null
            ? 'the image’s OCI label, since the pin is a bare major'
            : `the image’s OCI label, built from ${recyclarr.running.revision}`,
        )}
        lede={
          <>
            Syncs the TRaSH Guides into Sonarr and Radarr every night: custom formats, their scores,
            and the quality-definition sizes. When a profile changes back after you edited it by
            hand, this is what did it.
          </>
        }
        actions={
          recyclarr.lastRun === null ? (
            <Chip tone="muted">no run recorded</Chip>
          ) : (
            <Chip tone={recyclarr.lastRun.ok ? 'ok' : 'bad'}>
              {recyclarr.lastRun.ok ? 'last run ok' : 'last run failed'}
            </Chip>
          )
        }
      />

      <BoardGrid>
        <Board
          title="Last sync"
          icon="⟳"
          span={8}
          aside={<span className={NOTE}>{recyclarr.lastRun?.day ?? DASH}</span>}
        >
          {recyclarr.synced.length === 0 ? (
            <p className={EMPTY}>no sync recorded in the window</p>
          ) : (
            <ul className={`${LIST} gap-[0.3rem]`}>
              {recyclarr.synced.map((s) => (
                <li key={s.instance} className={CHECK_ROW}>
                  <span className="text-[0.72rem] uppercase tracking-[0.04em] text-muted-foreground">
                    {s.instance}
                  </span>
                  <span className="min-w-0 text-foreground">
                    {s.updated === 0 ? (
                      'nothing changed'
                    ) : (
                      <strong>
                        {num(s.updated)} custom format{s.updated === 1 ? '' : 's'} updated
                      </strong>
                    )}
                    {' · '}
                    {num(s.skipped)} already current
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            The last run&rsquo;s numbers, not a total: a nightly job that changed two formats every
            night for a week did not change fourteen. Read out of its log, because Recyclarr has no
            API, no metrics and no interface.
          </p>
        </Board>

        <Board title="Health" icon="warn" span={4}>
          <Measures
            items={[
              {
                k: `Errors, last ${String(d.days)} days`,
                v: num(recyclarr.errors),
                tone: (recyclarr.errors ?? 0) > 0 ? 'warn' : undefined,
              },
            ]}
          />
          <p className={FOOT}>
            It runs once a day and exits. There is no process to probe between runs, so the only
            evidence it is working is the line its cron wrapper writes when it finishes.
          </p>
        </Board>

        <Changelog
          gap={recyclarr.gap}
          span={12}
          aside={
            recyclarr.running.revision === null ? (
              <span className={NOTE}>recyclarr/recyclarr</span>
            ) : (
              <span className={cn(NOTE, MONO)}>{recyclarr.running.revision}</span>
            )
          }
          foot={
            <p className={FOOT}>
              Recyclarr is pinned to a bare major (<span className={MONO}>:8</span>), which is a
              channel rather than a version. It prints no banner, exposes no API and logs nothing
              about itself. This page used to say its version could not be established. It can: the
              image records it, along with the commit it was built from.
            </p>
          }
        />

        <LogBoard
          source={{ container: 'recyclarr' }}
          title="Recyclarr logs"
          neighbours={[VERSION_SNAPSHOT]}
        />
      </BoardGrid>
    </>
  )
}
