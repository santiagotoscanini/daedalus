import { useState } from 'react'

import {
  Board,
  BoardGrid,
  Chip,
  Facts,
  Measures,
  Progress,
  Pulse,
  RankRow,
  Ring,
  Trend,
  type Tone,
} from '../viz'
import { LogBoard, type LogNeighbour } from '../logs'
import { Changelog } from '../release-notes'
import { ServiceHead, verdictOf, type CompareRow } from '../service-head'
import { Segmented } from '../ui'
import { DASH, bytes, flag, num, rate, since, until } from '../../lib/dashboard/format'
import type { VersionGap } from '../../lib/dashboard/github'
import type { RunningVersion } from '../../lib/dashboard/images'
import type { MediaData } from '../../server/category'

// The Media pages — a tab per job, and a switch inside the page for the
// services that share one.
//
// Every service page opens the way the AI and Gaming tabs do: artwork, the
// name, the version running, the verdict on whether that version is current,
// one sentence saying where this service sits in the chain, and the link you
// came to click. Sixteen containers whose UIs look nothing alike become pages
// that are read the same way.
//
// ── why some tabs hold three services ─────────────────────────────────────
//
// Because the split between them is the software's, not the reader's. Seerr,
// Sonarr and Radarr answer one question — what should be here that isn't —
// and a tab each meant reassembling that answer from three pages. The switch
// is the same one Network uses for its three ways in, down to the health dot
// riding the button that selects each option, which is the only place that dot
// can be read without first selecting the thing it belongs to.

export function MediaView({ data }: { data: MediaData }) {
  switch (data.tab) {
    case 'jellyfin':
      return <JellyfinView d={data} />
    case 'calibre':
      return <CalibreView d={data} />
    case 'wanted':
      return <WantedView d={data} />
    case 'indexer':
      return <ProwlarrView d={data} />
    case 'downloaders':
      return <DownloadersView d={data} />
    case 'cleanup':
      return <CleanupView d={data} />
  }
}

/* ── shared ───────────────────────────────────────────────────────────── */

/**
 * Where a running version came from, in the four words the header has room for.
 *
 * Not decoration: the three sources carry different weight. A version the
 * service reported about itself is a measurement. One read off the tag the
 * flake pins is reproducible from git but only true while the tag names a
 * release. One read off the image's OCI label is a claim the publisher made
 * about an artefact that a re-pull could silently replace — which is exactly
 * the case for every service pinned to a moving tag, and the reason those
 * pages used to say nothing at all.
 */
const SOURCE_NOTE: Record<RunningVersion['source'], string> = {
  pin: 'from the tag the flake pins',
  label: 'from the image’s own label',
  unknown: 'unknown — the pin names a channel',
}

/**
 * The working behind a version verdict, shown on hover.
 *
 * `note` says where the running number came from, which is the fact that
 * decides how much the verdict is worth: a version the service reported about
 * itself is a measurement, and a version read off the tag the flake pins is an
 * assumption that holds only while the tag does.
 */
function compareOf(gap: VersionGap, note: string): CompareRow[] {
  return [
    {
      k: 'Latest',
      v: gap.latest,
      note:
        gap.latest === null ? 'GitHub did not answer'
        : gap.behind.length === 0 ? 'this is what is running'
        : `${String(gap.behind.length)} release${gap.behind.length === 1 ? '' : 's'} between them`,
    },
    { k: 'Running', v: gap.installed, note },
  ]
}

/**
 * A tri-state health as a dot tone.
 *
 * `null` is "could not be read", which is grey — deliberately not the same
 * claim as down, and the state a service lands in when the thing that would
 * answer for it is itself unreachable.
 */
function tone(ok: boolean | null): Tone | null {
  return ok === null ? null : ok ? 'ok' : 'bad'
}

/** The switch above a tab that holds more than one service. */
function ServiceBar<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T
  onChange: (v: T) => void
  options: { value: T; label: string; dot?: Tone | null }[]
}) {
  return (
    <div className="tunnel-bar">
      <Segmented value={value} onChange={onChange} options={options} />
    </div>
  )
}

/** Whole days as a phrase. Computed on the server — see `daysSince`. */
function ago(days: number | null): string {
  if (days === null) return DASH
  if (days === 0) return 'today'
  if (days === 1) return 'yesterday'
  if (days < 30) return `${String(days)}d ago`
  if (days < 365) return `${String(Math.round(days / 30))}mo ago`
  return `${String(Math.round(days / 365))}y ago`
}

/** The same, forwards. */
function inDays(days: number): string {
  if (days <= 0) return 'today'
  if (days === 1) return 'tomorrow'
  return `in ${String(days)}d`
}

/**
 * A service's own health checks.
 *
 * The single most useful thing on the *arr pages and the one thing nothing else
 * on this box reports: an indexer that has been failing for a week, a root
 * folder that has gone missing, a download client that stopped answering. Every
 * one of those is invisible in the counts — the queue is empty and the library
 * is intact, because nothing is being attempted.
 *
 * Silence is a real answer here and gets said out loud, because an empty panel
 * and a panel that could not be read look identical otherwise.
 */
function HealthChecks({
  checks,
  reachable,
}: {
  checks: { level: 'warn' | 'bad'; source: string; message: string; url: string | null }[]
  reachable: boolean
}) {
  if (!reachable) return <p className="viz-empty">could not ask</p>
  if (checks.length === 0)
    return <p className="viz-empty">No warnings — every check this service runs is passing.</p>

  return (
    <ul className="hchecks">
      {checks.map((c) => (
        <li key={`${c.source}-${c.message}`} className={`hcheck hcheck-${c.level}`}>
          <span className="hcheck-src">{c.source}</span>
          <span className="hcheck-msg">
            {c.message}
            {c.url !== null && (
              <a href={c.url} target="_blank" rel="noreferrer">
                {' '}
                wiki ↗
              </a>
            )}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * The oneshot behind every "from the image's own label" version on this page.
 *
 * A neighbour of Shelfmark, Janitorr and Recyclarr specifically — the three
 * whose pin is a channel, so the snapshot is the ONLY thing that knows what
 * they are running. When one of them starts reporting "unknown", this is the
 * log that says why, and it is the reason a systemd unit can be a neighbour at
 * all (see `LogNeighbour`).
 */
const VERSION_SNAPSHOT: LogNeighbour = {
  source: { unit: 'daedalus-image-snapshot.service' },
  label: 'Version snapshot',
  role: 'where this version comes from',
  note: 'Reads the OCI labels off every running image and publishes them for this dashboard, since the pin on these three names a channel rather than a release. One line per run with the counts; if the version above says “unknown”, this says whether the snapshot ran at all. Its failures also send mail — see fleet.monitoredJobs in stacks/daedalus.',
}

/** The button every service head carries. */
function Open({ name, host }: { name: string; host: string }) {
  return (
    <a className="btn btn-primary" href={`https://${host}.toscanini.me`} target="_blank" rel="noreferrer">
      Open {name} ↗
    </a>
  )
}

/* ── Jellyfin ─────────────────────────────────────────────────────────── */

/** Idle longer than this and an account is worth noticing rather than listing. */
const STALE_DAYS = 60

function JellyfinView({ d }: { d: Extract<MediaData, { tab: 'jellyfin' }> }) {
  const { library, counts } = d
  const total =
    library.usedBytes !== null && library.freeBytes !== null ?
      library.usedBytes + library.freeBytes
    : null
  const transcoding = d.playing.filter((s) => s.method === 'Transcode').length

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
            Where everything on this page ends up. Streams from <span className="mono">/s2/tv</span>{' '}
            and transcodes on the iGPU — the one media container deliberately outside the VPN, so
            playing something at home does not go out through Switzerland and back.
          </>
        }
        actions={<Open name="Jellyfin" host="jellyfin" />}
      />

      <BoardGrid>
        <Board
          title="Playing now"
          icon="▶"
          span={8}
          aside={
            transcoding === 0 ?
              undefined
            : <span className="board-note">{num(transcoding)} transcoding</span>
          }
        >
          {d.playing.length === 0 ?
            <p className="viz-empty">Nobody is watching anything.</p>
          : <ul className="playing">
              {d.playing.map((s, i) => (
                <li key={`${s.user}-${String(i)}`} className="playing-row">
                  <div className="playing-head">
                    <span className="playing-title">
                      <Pulse on={!s.paused} tone="ok" />
                      {s.title}
                      {s.sub !== null && <em> — {s.sub}</em>}
                    </span>
                    <span className="playing-tags">
                      <Chip tone="info">{s.user}</Chip>
                      {s.device !== null && <Chip>{s.device}</Chip>}
                      {/* Transcode vs DirectPlay is the difference between a
                          quiet box and a pegged iGPU. */}
                      {s.method !== null && (
                        <Chip tone={s.method === 'Transcode' ? 'warn' : 'ok'}>{s.method}</Chip>
                      )}
                      {s.paused && <Chip tone="muted">paused</Chip>}
                    </span>
                  </div>
                  <Progress
                    pct={s.pct}
                    tone={s.paused ? 'muted' : 'ok'}
                    active={!s.paused}
                    height={8}
                  />
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            Only sessions actually playing something. Every poller that has ever asked Jellyfin a
            question holds an idle session for a while afterwards, so the raw list reports an
            audience that is not in the room.
          </p>
        </Board>

        <Board title="Library" icon="▦" span={4}>
          <div className="library-split">
            <Ring
              pct={
                total === null || library.usedBytes === null ?
                  null
                : (library.usedBytes / total) * 100
              }
              value={bytes(library.usedBytes)}
              label="/s2/tv"
              tone="info"
            />
            <Facts
              rows={[
                { k: 'Movies', v: num(counts.movies) },
                { k: 'Series', v: num(counts.series) },
                { k: 'Episodes', v: num(counts.episodes) },
                { k: 'Free on pool', v: bytes(library.freeBytes) },
              ]}
            />
          </div>
          <h4 className="board-sub">Growth, 30 days</h4>
          <Trend values={library.growth} tone="info" height={70} />
        </Board>

        <Board
          title="Who watches"
          icon="◍"
          span={4}
          aside={<span className="board-note">{num(d.people.length)} accounts</span>}
        >
          {d.people.length === 0 ?
            <p className="viz-empty">could not read the user list</p>
          : <ul className="who">
              {d.people.map((p) => (
                <li key={p.name} className="who-row">
                  <span className="who-name">{p.name}</span>
                  <span
                    className={
                      p.lastSeenDays !== null && p.lastSeenDays > STALE_DAYS ?
                        'who-when is-muted'
                      : 'who-when'
                    }
                  >
                    {ago(p.lastSeenDays)}
                  </span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            Last activity, not last login — a client that stays signed in reports the second one
            once and never again, which is why an account in daily use can show a login from May.
          </p>
        </Board>

        <Changelog
          gap={d.gap}
          span={8}
          aside={
            d.pendingRestart ?
              <span className="board-note text-warn">restart pending</span>
            : <span className="board-note">github</span>
          }
        />

        <LogBoard source={{ container: 'jellyfin' }} title="Jellyfin logs" />
      </BoardGrid>
    </>
  )
}

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
    note: 'Polls Sonarr, Radarr, Prowlarr and Bazarr on a timer and republishes what they say as prometheus metrics. Nothing on this tab reads it — every number here comes from the *arrs directly — but the dashboards on the Monitoring page do, so a flat line there starts here. Expect periodic “scrape failed” and “No data found” errors: those four are dialled at a rootless-published host port, where a new connection occasionally hangs ~10.5s, and scraparr gives up at a hardcoded 10 with no retry. The scrape after it succeeds and the previous value is kept, so the metrics stay correct — but scraparr_services_up dips while it happens.',
  },
]

type Wanted = Extract<MediaData, { tab: 'wanted' }>

function WantedView({ d }: { d: Wanted }) {
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

      {who === 'seerr' ?
        <SeerrPage d={d.seerr} />
      : who === 'recyclarr' ?
        <RecyclarrPage d={d.recyclarr} />
      : who === 'bazarr' ?
        <BazarrPage d={d.bazarr} />
      : <ArrPage d={who === 'sonarr' ? d.sonarr : d.radarr} />}
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
            hands it straight to Radarr or Sonarr — the two services beside it on this tab.
          </>
        }
        actions={<Open name="Seerr" host="seerr" />}
      />

      <BoardGrid>
        <Board
          title="Recent requests"
          icon="✧"
          span={8}
          aside={<span className="board-note">{num(counts.total)} all time</span>}
        >
          {d.requests.length === 0 ?
            <p className="viz-empty">Nothing has been requested.</p>
          : <ul className="reqs">
              {d.requests.map((r, i) => (
                <li key={`${r.title}-${String(i)}`} className="req">
                  <Chip tone={r.tone}>{r.status}</Chip>
                  <span className="req-title">{r.title}</span>
                  <span className="req-kind">{r.kind === 'tv' ? 'series' : 'film'}</span>
                  <span className="req-by">{r.by}</span>
                  <span className="req-when">{ago(r.ageDays)}</span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            Titles are looked up per request: a request record carries a TMDB id and nothing else,
            so Seerr resolves the name the same way its own interface does.
          </p>
        </Board>

        <Board title="Where they are" icon="◷" span={4}>
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
          <p className="board-foot">
            Pending is the only one that needs a person: everything else is either the machinery
            working or a decision already taken.
          </p>
        </Board>

        <Board title="Who asks" icon="◍" span={4}>
          {d.people.length === 0 ?
            <p className="viz-empty">no requests yet</p>
          : <ul className="ranks">
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
          }
        </Board>

        <Changelog
          gap={d.gap}
          span={8}
          aside={
            d.selfBehind !== null && d.selfBehind > 0 ?
              <span className="board-note">{num(d.selfBehind)} commits behind, it says</span>
            : <span className="board-note">github</span>
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
    lede: 'The same program as Sonarr, pointed at films. Same indexers, same downloaders, same folder — the difference is that a film has a release date rather than a schedule.',
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
          icon="⚠"
          span={8}
          aside={<span className="board-note">its own health checks</span>}
        >
          <HealthChecks checks={d.health} reachable={reachable} />
        </Board>

        <Board title="The library" icon="▦" span={4}>
          <Facts
            rows={[
              { k: copy.unit, v: num(counts.library) },
              { k: 'Monitored', v: num(counts.monitored) },
              { k: 'On disk', v: bytes(counts.sizeBytes) },
              {
                k: 'Still wanted',
                v:
                  (counts.wanted ?? 0) === 0 ?
                    num(counts.wanted)
                  : <span className="text-warn">{num(counts.wanted)}</span>,
              },
            ]}
          />
          {d.disk.map((disk) => (
            <div key={disk.path}>
              <h4 className="board-sub">{disk.path}</h4>
              <Progress
                pct={
                  disk.totalBytes > 0 ?
                    ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100
                  : null
                }
                tone="info"
              />
              <p className="board-foot">
                {bytes(disk.freeBytes)} free of {bytes(disk.totalBytes)}
              </p>
            </div>
          ))}
        </Board>

        <Board
          title="Queue"
          icon="⇣"
          span={8}
          aside={
            <span className="board-note">
              {num(counts.queued)} item{counts.queued === 1 ? '' : 's'}
            </span>
          }
        >
          {d.queue.length === 0 ?
            <p className="viz-empty">
              Nothing in the queue. Completed downloads are removed once imported.
            </p>
          : <ul className="transfers">
              {d.queue.map((q, i) => (
                <li key={`${q.title}-${String(i)}`} className="transfers-row">
                  <div className="transfers-head">
                    <span className="transfers-name" title={q.title}>
                      {q.title}
                    </span>
                    <span className="transfers-meta">
                      {q.pct.toFixed(0)}% of {bytes(q.sizeBytes)}
                      {q.issue !== null && <span className="bad-text"> · {q.issue}</span>}
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
          }
          <p className="board-foot">
            An item stuck at 100% with a note against it is the failure this panel exists for: the
            download finished and the import did not, so nothing is moving and nothing is wrong
            anywhere else.
          </p>
        </Board>

        <Board title={copy.upcoming} icon="◷" span={4}>
          {d.upcoming.length === 0 ?
            <p className="viz-empty">Nothing scheduled in the next fortnight.</p>
          : <ul className="upnext">
              {d.upcoming.map((u, i) => (
                <li key={`${u.title}-${String(i)}`} className="upnext-row">
                  <span className="upnext-title" title={u.sub ?? u.title}>
                    {u.title}
                    {u.sub !== null && <em>{u.sub}</em>}
                  </span>
                  <span className={u.have ? 'upnext-when is-muted' : 'upnext-when'}>
                    {u.have ? 'have it' : inDays(u.inDays)}
                  </span>
                </li>
              ))}
            </ul>
          }
        </Board>

        <Board title="Lately" icon="≋" span={12}>
          {d.history.length === 0 ?
            <p className="viz-empty">no recorded activity</p>
          : <ul className="feed">
              {d.history.map((h, i) => (
                <li key={`${h.title}-${String(i)}`} className="feed-row">
                  <span className={h.tone === 'muted' ? 'feed-event' : `feed-event text-${h.tone}`}>
                    {h.event}
                  </span>
                  <span className="feed-title" title={h.title}>
                    {h.title}
                  </span>
                  <span className="feed-when">{ago(h.ageDays)}</span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
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

function ProwlarrView({ d }: { d: Extract<MediaData, { tab: 'indexer' }> }) {
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
          {d.indexers.length === 0 ?
            <p className="viz-empty">no indexer statistics</p>
          : <ul className="ranks">
              {d.indexers.map((i) => (
                <RankRow
                  key={i.name}
                  name={i.name}
                  badges={[
                    ...(i.enabled ? [] : [{ text: 'disabled', tone: 'muted' as const }]),
                    ...(i.queries > 0 && i.failedQueries / i.queries > 0.25 ?
                      [
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
          }
          <p className="board-foot">
            Queries are the bar, because that is what the *arrs actually spend. Grabs beside it is
            the yield: an indexer with thousands of queries and no grabs is being searched and never
            has the answer, which is a reason to turn it off rather than a fault.
          </p>
        </Board>

        <Board title="What it says is wrong" icon="⚠" span={12}>
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

/* ── Bazarr — reached from the Wanted switch above ────────────────────── */

const BAZARR_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { container: 'subgen' },
    label: 'Subgen',
    role: 'Whisper, for the subtitles nobody published',
    note: 'Registered with Bazarr as the `whisperai` provider. When an episode has no subtitles anywhere, this transcribes the audio instead — on the CPU, so a single film can take a long time and the only evidence it is working is here.',
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
            Radarr&rsquo;s libraries directly, so nothing here decides what exists — only what is
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
            throttled.length === 0 ?
              <span className="board-note">all answering</span>
            : <span className="board-note text-warn">{num(throttled.length)} throttled</span>
          }
        >
          {d.providers.length === 0 ?
            <p className="viz-empty">could not read the provider list</p>
          : <ul className="provs">
              {d.providers.map((p) => (
                <li key={p.name} className="prov">
                  <Chip tone={p.ok ? 'ok' : 'warn'}>{p.status}</Chip>
                  <span className="prov-name mono">{p.name}</span>
                  {p.retry !== '-' && <span className="prov-retry">retry {p.retry}</span>}
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            The panel that explains a subtitle which never arrives. A throttled provider answers
            nothing and reports no error, so &ldquo;none found&rdquo; and &ldquo;we are not
            currently allowed to ask&rdquo; look identical everywhere except here.
          </p>
        </Board>

        <Board title="Still missing" icon="◷" span={4}>
          <Facts
            rows={[
              { k: 'Episodes', v: num(d.wanted.episodes) },
              { k: 'Movies', v: num(d.wanted.movies) },
              { k: 'Sees Sonarr', v: <span className="mono">{d.linked.sonarr ?? DASH}</span> },
              { k: 'Sees Radarr', v: <span className="mono">{d.linked.radarr ?? DASH}</span> },
            ]}
          />
          <p className="board-foot">
            The two versions are Bazarr&rsquo;s own view of the *arrs it is wired to — a cheap
            cross-check that both connections are live, since a broken one reports zero missing
            rather than an error.
          </p>
        </Board>

        <Changelog
          gap={d.gap}
          span={12}
          aside={
            d.subgen === null ?
              <span className="board-note">github</span>
            : <span className="board-note">
                Subgen <span className="mono">{d.subgen}</span>
              </span>
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

/* ── Downloaders: qBittorrent, NZBGet, MeTube, Shelfmark ──────────────── */

type Downloaders = Extract<MediaData, { tab: 'downloaders' }>

function DownloadersView({ d }: { d: Downloaders }) {
  // qBittorrent first: it is the one the *arrs reach for by default and the
  // only one of the four whose state changes minute to minute.
  const [which, setWhich] = useState<'qbt' | 'nzb' | 'metube' | 'shelfmark'>('qbt')

  return (
    <>
      <ServiceBar
        value={which}
        onChange={setWhich}
        options={[
          { value: 'qbt', label: 'qBittorrent', dot: tone(d.qbt.reachable) },
          { value: 'nzb', label: 'NZBGet', dot: tone(d.nzb.version !== null) },
          { value: 'metube', label: 'MeTube', dot: tone(d.metube.done !== null) },
          // Shelfmark is here rather than beside the shelf it fills, because
          // what it IS is a downloader — and the question "why has this not
          // arrived" should not be answered in a different part of the tab row
          // depending on whether the thing is a book.
          { value: 'shelfmark', label: 'Shelfmark', dot: tone(d.shelfmark.counts !== null) },
        ]}
      />

      {which === 'qbt' ?
        <QbtPage d={d} />
      : which === 'nzb' ?
        <NzbPage d={d} />
      : which === 'shelfmark' ?
        <ShelfmarkPage d={d} />
      : <MetubePage d={d.metube} />}
    </>
  )
}

/**
 * The tunnel, as three facts rather than a panel.
 *
 * It has a page of its own on Network › Going out, and the only part that
 * belongs on a downloader page is the part that silently changes what the page
 * is reporting: a tunnel that is up but has lost its forwarded port looks
 * perfectly healthy and cannot seed.
 */
function TunnelBoard({ vpn, span }: { vpn: Downloaders['vpn']; span: 4 | 6 }) {
  return (
    <Board title="The tunnel" icon="⛨" span={span}>
      <div className="vpn-state">
        <Pulse on={vpn.up === true} tone={vpn.up === true ? 'ok' : 'bad'} />
        <strong>{vpn.up === null ? 'unknown' : vpn.up ? 'connected' : 'down'}</strong>
      </div>
      <Facts
        rows={[
          { k: 'Exit', v: flag(vpn.country) },
          {
            k: 'Forwarded port',
            v:
              vpn.port === null ?
                <span className="text-bad">not forwarded</span>
              : <span className="mono">{vpn.port}</span>,
          },
        ]}
      />
      <p className="board-foot">
        Every downloader on this tab shares gluetun&rsquo;s network namespace, so every byte crossed
        this tunnel. The full picture is on Network › Going out; what is here is what changes the
        meaning of the panels beside it.
      </p>
    </Board>
  )
}

function QbtPage({ d }: { d: Downloaders }) {
  const { qbt } = d

  return (
    <>
      <ServiceHead
        logo="/icon-qbittorrent.svg"
        name="qBittorrent"
        version={qbt.version}
        versionNote="reported by the app"
        verdict={verdictOf(qbt.gap)}
        compare={compareOf(qbt.gap, 'from /api/v2/app/version')}
        lede={
          <>
            The torrent half, and what the *arrs reach for first. Runs inside gluetun&rsquo;s
            network namespace, which is also why its forwarded port is a fact worth watching:
            without one it can download and never seed.
          </>
        }
        actions={<Open name="qBittorrent" host="qbittorrent" />}
      />

      <BoardGrid>
        <Board
          title="Transfers"
          icon="⇣"
          span={8}
          aside={
            <span className="board-note">
              <Pulse on={(qbt.down ?? 0) + (qbt.up ?? 0) > 0} tone="accent" />
              {qbt.connection ?? DASH}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'Down', v: rate(qbt.down) },
              { k: 'Up', v: rate(qbt.up) },
              { k: 'Session', v: `${bytes(qbt.sessionDown)} in · ${bytes(qbt.sessionUp)} out` },
              { k: 'Free', v: bytes(qbt.freeBytes) },
            ]}
          />
          {qbt.transfers.length === 0 ?
            <p className="viz-empty">
              {qbt.reachable ?
                'Nothing downloading. Completed torrents are removed after import.'
              : 'qBittorrent did not accept the login.'}
            </p>
          : <ul className="transfers">
              {qbt.transfers.map((t) => (
                <li key={t.name} className="transfers-row">
                  <div className="transfers-head">
                    <span className="transfers-name" title={t.name}>
                      {t.name}
                    </span>
                    <span className="transfers-meta">
                      {t.active && <>{rate(t.down)} · </>}
                      {t.pct.toFixed(0)}% of {bytes(t.size)}
                      {t.etaSeconds !== null && <> · {until(t.etaSeconds)} left</>}
                      {t.pct >= 100 && <> · ratio {t.ratio.toFixed(2)}</>}
                    </span>
                  </div>
                  <Progress pct={t.pct} tone={t.active ? 'accent' : 'muted'} active={t.active} />
                </li>
              ))}
            </ul>
          }
        </Board>

        <TunnelBoard vpn={d.vpn} span={4} />

        <Board title="The swarm" icon="⁘" span={4}>
          <Facts
            rows={[
              { k: 'Downloading', v: num(qbt.counts.leeching) },
              { k: 'Seeding', v: num(qbt.counts.seeding) },
              {
                k: 'Stalled',
                v:
                  qbt.counts.stalled === 0 ?
                    num(0)
                  : <span className="text-warn">{num(qbt.counts.stalled)}</span>,
              },
              {
                k: 'Errored',
                v:
                  qbt.counts.errored === 0 ?
                    num(0)
                  : <span className="text-bad">{num(qbt.counts.errored)}</span>,
              },
            ]}
          />
          <p className="board-foot">
            Stalled is the state that needs reading in context: with a forwarded port it usually
            means no seeders, and without one it means every torrent will end up here.
          </p>
        </Board>

        <Changelog gap={qbt.gap} span={8} aside={<span className="board-note">qbittorrent</span>} />

        <LogBoard source={{ container: 'qbittorrent' }} title="qBittorrent logs" />
      </BoardGrid>
    </>
  )
}

function NzbPage({ d }: { d: Downloaders }) {
  const { nzb } = d
  const inactive = nzb.servers.filter((s) => !s.active).length
  const total = nzb.freeBytes

  return (
    <>
      <ServiceHead
        logo="/icon-nzbget.svg"
        name="NZBGet"
        version={nzb.version}
        versionNote="reported by the app"
        verdict={verdictOf(nzb.gap)}
        compare={compareOf(nzb.gap, 'from /jsonrpc/version')}
        lede={
          <>
            The usenet half. Faster than a torrent when the post is fully retained and useless when
            it is not — which is a property of the provider rather than of the release, and the
            reason the news-server list below is on this page.
          </>
        }
        actions={<Open name="NZBGet" host="nzbget" />}
      />

      <BoardGrid>
        <Board
          title="Downloading"
          icon="⇣"
          span={8}
          aside={
            <span className="board-note">
              <Pulse on={(nzb.rate ?? 0) > 0} tone="accent" />
              {nzb.paused ? 'paused'
              : nzb.standby ? 'idle'
              : 'active'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'Rate', v: rate(nzb.rate) },
              { k: 'Remaining', v: bytes(nzb.remainingBytes) },
              { k: 'Today', v: bytes(nzb.dayBytes) },
              { k: 'This month', v: bytes(nzb.monthBytes) },
            ]}
          />
          {nzb.groups.length === 0 ?
            <p className="viz-empty">Nothing in the queue.</p>
          : <ul className="transfers">
              {nzb.groups.map((g) => (
                <li key={g.name} className="transfers-row">
                  <div className="transfers-head">
                    <span className="transfers-name" title={g.name}>
                      {g.name}
                    </span>
                    <span className="transfers-meta">
                      {g.pct.toFixed(0)}% · {bytes(g.remainingBytes)} left
                    </span>
                  </div>
                  <Progress pct={g.pct} tone="info" active={!nzb.paused} />
                </li>
              ))}
            </ul>
          }
        </Board>

        <TunnelBoard vpn={d.vpn} span={4} />

        <Board
          title="News servers"
          icon="⛁"
          span={4}
          aside={
            inactive === 0 ?
              <span className="board-note">all active</span>
            : <span className="board-note text-bad">{num(inactive)} inactive</span>
          }
        >
          {nzb.servers.length === 0 ?
            <p className="viz-empty">could not read the server list</p>
          : <ul className="provs">
              {nzb.servers.map((s) => (
                <li key={s.id} className="prov">
                  <Chip tone={s.active ? 'ok' : 'bad'}>{s.active ? 'active' : 'inactive'}</Chip>
                  <span className="prov-name mono">server {s.id}</span>
                </li>
              ))}
            </ul>
          }
          <Facts
            rows={[
              { k: 'Uptime', v: since(nzb.uptimeSeconds) },
              { k: 'Spent downloading', v: since(nzb.downloadSeconds) },
              { k: 'Free where it writes', v: bytes(total) },
            ]}
          />
          <p className="board-foot">
            A provider whose subscription lapses goes inactive and everything simply stops being
            found — which from Sonarr&rsquo;s side is indistinguishable from the release not
            existing.
          </p>
        </Board>

        <Changelog gap={nzb.gap} span={8} aside={<span className="board-note">nzbgetcom/nzbget</span>} />

        <LogBoard source={{ container: 'nzbget' }} title="NZBGet logs" />
      </BoardGrid>
    </>
  )
}

function MetubePage({ d }: { d: Downloaders['metube'] }) {
  return (
    <>
      <ServiceHead
        logo="/icon-metube.svg"
        name="MeTube"
        version={d.version}
        versionNote="from the tag the flake pins"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'the image tag — MeTube serves no version')}
        lede={
          <>
            yt-dlp with a web form in front of it, and the only downloader here that nothing else
            drives — you point it at a URL yourself. Also inside the VPN namespace, which is
            occasionally why a site refuses it.
          </>
        }
        actions={<Open name="MeTube" host="metube" />}
      />

      <BoardGrid>
        <Board
          title="Queue"
          icon="⇣"
          span={8}
          aside={
            <span className="board-note">
              {num(d.queued)} queued · {num(d.pending)} pending
            </span>
          }
        >
          {d.recent.length === 0 ?
            <p className="viz-empty">Nothing downloaded yet.</p>
          : <ul className="feed">
              {d.recent.map((r, i) => (
                <li key={`${r.title}-${String(i)}`} className="feed-row">
                  <span className={r.status === 'finished' ? 'feed-event' : 'feed-event text-bad'}>
                    {r.status}
                  </span>
                  <span className="feed-title" title={r.title}>
                    {r.title}
                  </span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            The most recent finished items. MeTube keeps its history in the browser session as well
            as on the server, so this list and the one in its own UI can differ.
          </p>
        </Board>

        <Board title="All time" icon="▦" span={4}>
          <Measures
            items={[
              { k: 'Completed', v: num(d.done) },
              { k: 'Queued', v: num(d.queued) },
              { k: 'Pending', v: num(d.pending) },
            ]}
          />
        </Board>

        <Changelog
          gap={d.gap}
          span={12}
          foot={
            <p className="board-foot">
              MeTube ships a new dated build most weeks and almost all of them are a yt-dlp bump —
              which is exactly what fixes a site that suddenly stopped downloading. It is the one
              service on this page where being behind is usually the whole explanation.
            </p>
          }
        />

        <LogBoard source={{ container: 'metube' }} title="MeTube logs" />
      </BoardGrid>
    </>
  )
}


function ShelfmarkPage({ d }: { d: Downloaders }) {
  const { shelfmark } = d
  const counts = shelfmark.counts

  return (
    <>
      <ServiceHead
        logo="/icon-shelfmark.png"
        name="Shelfmark"
        version={shelfmark.running.version}
        versionNote={SOURCE_NOTE[shelfmark.running.source]}
        verdict={verdictOf(shelfmark.gap)}
        compare={compareOf(
          shelfmark.gap,
          // The pin is `:latest` by digest, so the tag names a channel and this
          // number comes from org.opencontainers.image.version in the image.
          shelfmark.running.revision === null ?
            'the image’s OCI label'
          : `the image’s OCI label · built from ${shelfmark.running.revision}`,
        )}
        lede={
          <>
            The half that goes and gets things: searches Anna&rsquo;s Archive through the downloads
            stack&rsquo;s VPN and drops finished files where Calibre-Web ingests them. A book that
            never appeared usually failed here, not on the shelf.
          </>
        }
        actions={<Open name="Shelfmark" host="shelfmark" />}
      />

      <BoardGrid>
        <Board
          title="Downloading"
          icon="⇣"
          span={8}
          aside={
            counts === null ?
              <span className="board-note">did not answer</span>
            : <span className="board-note">
                {num(counts.done)} completed · {num(counts.errors)} failed
              </span>
          }
        >
          {shelfmark.jobs.length === 0 ?
            <p className="viz-empty">Queue is empty.</p>
          : <ul className="transfers">
              {shelfmark.jobs.map((j, i) => (
                <li key={`${j.title}-${String(i)}`} className="transfers-row">
                  <div className="transfers-head">
                    <span className="transfers-name" title={j.title}>
                      {j.title}
                    </span>
                    <span className="transfers-meta">
                      <Chip tone={j.state === 'error' ? 'bad' : 'info'}>{j.state}</Chip>
                    </span>
                  </div>
                  <Progress
                    pct={j.pct}
                    tone={j.state === 'error' ? 'bad' : 'accent'}
                    active={j.state === 'downloading'}
                  />
                </li>
              ))}
            </ul>
          }
        </Board>

        <Board title="Queue" icon="◷" span={4}>
          {counts === null ?
            <p className="viz-empty">no reading</p>
          : <Measures
              items={[
                { k: 'Downloading', v: num(counts.downloading) },
                { k: 'Queued', v: num(counts.queued) },
                { k: 'Completed', v: num(counts.done) },
                {
                  k: 'Errors',
                  v: num(counts.errors),
                  tone: counts.errors > 0 ? 'warn' : undefined,
                },
              ]}
            />
          }
        </Board>

        <Changelog
          gap={shelfmark.gap}
          span={12}
          aside={
            shelfmark.running.revision === null ?
              <span className="board-note">calibrain/shelfmark</span>
            : <span className="board-note mono">{shelfmark.running.revision}</span>
          }
          foot={
            <p className="board-foot">
              The pin is a moving <span className="mono">:latest</span> by digest, so the tag says
              nothing — but the image does. Its OCI labels carry the version and the commit it was
              built from, which is what makes this a real gap rather than a list of everything that
              has ever shipped.
            </p>
          }
        />

        <LogBoard
          source={{ container: 'shelfmark' }}
          title="Shelfmark logs"
          neighbours={[VERSION_SNAPSHOT]}
        />
      </BoardGrid>
    </>
  )
}
/* ── Calibre ──────────────────────────────────────────────────────────── */

type Calibre = Extract<MediaData, { tab: 'calibre' }>

/**
 * The shelf, next to Jellyfin rather than paired with its downloader.
 *
 * Both are where a pipeline ENDS — the thing a person opens — which is what
 * the rule on the tab row divides. Pairing Calibre with Shelfmark instead put
 * one downloader on the far side of that line from the other three.
 */
function CalibreView({ d }: { d: Calibre }) {
  const calibre = d
  const { disk } = d

  return (
    <>
      <ServiceHead
        logo="/icon-calibre-web.svg"
        name="Calibre"
        version={calibre.version}
        versionNote="from the tag the flake pins"
        verdict={verdictOf(calibre.gap)}
        compare={compareOf(calibre.gap, 'the image tag — the app serves no version')}
        lede={
          <>
            The shelf itself: Calibre-Web-Automated ingests whatever lands in{' '}
            <span className="mono">/s2/books</span> and serves it to readers over OPDS and the web.
          </>
        }
        actions={<Open name="Calibre" host="calibre" />}
      />

      <BoardGrid>
        <Board title="The shelf" icon="❏" span={8}>
          <Facts
            rows={[
              { k: 'Books', v: num(calibre.books) },
              { k: 'Authors', v: num(calibre.authors) },
              { k: 'Series', v: num(calibre.series) },
              { k: 'Categories', v: num(calibre.categories) },
            ]}
          />
          <p className="board-foot">
            Read through the OPDS catalogue with its own credentials — the same endpoint an e-reader
            uses, which is also the one path on this app that skips the Pocket ID gate.
          </p>
        </Board>

        <Board title="Disk" icon="▦" span={4}>
          <Measures
            items={[
              { k: 'On disk', v: bytes(disk.usedBytes) },
              { k: 'Free', v: bytes(disk.freeBytes) },
            ]}
          />
        </Board>

        <Changelog gap={calibre.gap} span={12} />

        <LogBoard source={{ container: 'calibre-web' }} title="Calibre-Web logs" />
      </BoardGrid>
    </>
  )
}

/* ── Cleanup: Cleanuparr, Janitorr ────────────────────────────────────── */

type Cleanup = Extract<MediaData, { tab: 'cleanup' }>

function CleanupView({ d }: { d: Cleanup }) {
  const [which, setWhich] = useState<'cleanuparr' | 'janitorr'>('cleanuparr')

  return (
    <>
      <ServiceBar
        value={which}
        onChange={setWhich}
        options={[
          { value: 'cleanuparr', label: 'Cleanuparr', dot: tone(d.cleanuparr.removed !== null) },
          // Whether it has SPOKEN in the last day, not whether we know its
          // version. That used to be the same test by accident — the version
          // came from a startup line in the log — and it stopped meaning
          // anything the moment the version started coming from the image,
          // which is present whether or not the container ever runs. Janitorr
          // announces its schedules hourly, so silence for a day is the signal.
          { value: 'janitorr', label: 'Janitorr', dot: tone(d.janitorr.schedules.length > 0) },
        ]}
      />

      {which === 'cleanuparr' ? <CleanuparrPage d={d} /> : <JanitorrPage d={d} />}
    </>
  )
}

function CleanuparrPage({ d }: { d: Cleanup }) {
  const { cleanuparr } = d
  const window = `last ${String(d.days)} days`

  return (
    <>
      <ServiceHead
        logo="/icon-cleanuparr.png"
        name="Cleanuparr"
        version={cleanuparr.version}
        versionNote="from the tag the flake pins"
        verdict={verdictOf(cleanuparr.gap)}
        compare={compareOf(cleanuparr.gap, 'the image tag — the API that reported it is closed')}
        lede={
          <>
            Unsticks the download queues: strikes items that stop progressing, blocks the ones that
            keep coming back, and asks the *arr for a replacement. It is why the queues on the
            Wanted tab are usually empty rather than full of dead entries.
          </>
        }
        actions={<Open name="Cleanuparr" host="cleanuparr" />}
      />

      <BoardGrid>
        <Board title="What it did" icon="⌫" span={8} aside={<span className="board-note">{window}</span>}>
          <Measures
            items={[
              { k: 'Stuck items removed', v: num(cleanuparr.removed) },
              {
                k: 'Blocked (kept returning)',
                v: num(cleanuparr.blocked),
                tone: (cleanuparr.blocked ?? 0) > 0 ? 'warn' : undefined,
              },
              { k: 'Replacement searches', v: num(cleanuparr.searches) },
            ]}
          />
          <p className="board-foot">
            Counted out of its own log lines in Loki. Cleanuparr publishes no metrics and 2.10.1
            closed the API that used to report this, so these three phrases are the interface.
          </p>
        </Board>

        <Board title="Why it is here" icon="◈" span={4}>
          <p className="board-foot">
            A download that stalls does not fail — it sits in the queue at 97% forever, and the
            *arr goes on believing the episode is handled. Nothing else on this box notices that.
            Cleanuparr strikes it, removes it, blocks the release and asks for another one.
          </p>
        </Board>

        <Changelog gap={cleanuparr.gap} span={12} />

        <LogBoard source={{ container: 'cleanuparr' }} title="Cleanuparr logs" />
      </BoardGrid>
    </>
  )
}

function JanitorrPage({ d }: { d: Cleanup }) {
  const { janitorr } = d
  const armed = janitorr.schedules.filter((s) => s.enabled).length

  return (
    <>
      <ServiceHead
        logo="/icon-janitorr.png"
        name="Janitorr"
        version={janitorr.running.version}
        versionNote={SOURCE_NOTE[janitorr.running.source]}
        verdict={verdictOf(janitorr.gap)}
        compare={compareOf(
          janitorr.gap,
          janitorr.running.revision === null ?
            'the image’s OCI label — the tag is a channel'
          : `the image’s OCI label · built from ${janitorr.running.revision}`,
        )}
        lede={
          <>
            Retention: deletes what nobody has watched, on a schedule. Running in dry-run, so it
            decides and then does nothing — which makes its log the whole of its output.
          </>
        }
        actions={
          <Chip tone={armed === 0 ? 'muted' : 'warn'}>
            {armed === 0 ? 'dry-run' : `${String(armed)} armed`}
          </Chip>
        }
      />

      <BoardGrid>
        <Board
          title="Schedules"
          icon="◷"
          span={8}
          aside={<span className="board-note">as it reports them hourly</span>}
        >
          {janitorr.schedules.length === 0 ?
            <p className="viz-empty">nothing in the last day&rsquo;s log</p>
          : <ul className="provs">
              {janitorr.schedules.map((s) => (
                <li key={s.name} className="prov">
                  <Chip tone={s.enabled ? 'warn' : 'muted'}>{s.enabled ? 'enabled' : 'off'}</Chip>
                  <span className="prov-name">{s.name} based cleanup</span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            The schedules that announce themselves — every hour, whether or not they do anything.
            Off here is what a deliberately disarmed retention service looks like, and without this
            panel it is indistinguishable from a broken one. It is not a list of everything Janitorr
            can do: its media-based cleanup says nothing either way on this box, which is why the
            count beside this one is the backstop.
          </p>
        </Board>

        <Board title="Would delete" icon="⌦" span={4}>
          <Measures items={[{ k: `Last ${String(d.days)} days`, v: num(janitorr.wouldDelete) }]} />
          <p className="board-foot">
            Dry-run — nothing is removed, so this is what it decided it would take if it were armed.
            The image is pinned to a moving <span className="mono">jvm-stable</span>, which carries
            no version; the one in the header comes from the image&rsquo;s own OCI label.
          </p>
        </Board>

        <Changelog gap={janitorr.gap} span={12} aside={<span className="board-note">Schaka/janitorr</span>} />

        <LogBoard
          source={{ container: 'janitorr' }}
          title="Janitorr logs"
          neighbours={[VERSION_SNAPSHOT]}
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
          recyclarr.running.revision === null ?
            'the image’s OCI label — the pin is a bare major'
          : `the image’s OCI label · built from ${recyclarr.running.revision}`,
        )}
        lede={
          <>
            Syncs the TRaSH Guides into Sonarr and Radarr every night: custom formats, their scores,
            and the quality-definition sizes. When a profile changes back after you edited it by
            hand, this is what did it.
          </>
        }
        actions={
          recyclarr.lastRun === null ?
            <Chip tone="muted">no run recorded</Chip>
          : <Chip tone={recyclarr.lastRun.ok ? 'ok' : 'bad'}>
              {recyclarr.lastRun.ok ? 'last run ok' : 'last run failed'}
            </Chip>
        }
      />

      <BoardGrid>
        <Board
          title="Last sync"
          icon="⟳"
          span={8}
          aside={<span className="board-note">{recyclarr.lastRun?.day ?? DASH}</span>}
        >
          {recyclarr.synced.length === 0 ?
            <p className="viz-empty">no sync recorded in the window</p>
          : <ul className="hchecks">
              {recyclarr.synced.map((s) => (
                <li key={s.instance} className="hcheck">
                  <span className="hcheck-src">{s.instance}</span>
                  <span className="hcheck-msg">
                    {s.updated === 0 ?
                      'nothing changed'
                    : <strong>
                        {num(s.updated)} custom format{s.updated === 1 ? '' : 's'} updated
                      </strong>
                    }
                    {' · '}
                    {num(s.skipped)} already current
                  </span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            The last run&rsquo;s numbers, not a total: a nightly job that changed two formats every
            night for a week did not change fourteen. Read out of its log, because Recyclarr has no
            API, no metrics and no interface.
          </p>
        </Board>

        <Board title="Health" icon="⚠" span={4}>
          <Measures
            items={[
              {
                k: `Errors, last ${String(d.days)} days`,
                v: num(recyclarr.errors),
                tone: (recyclarr.errors ?? 0) > 0 ? 'warn' : undefined,
              },
            ]}
          />
          <p className="board-foot">
            It runs once a day and exits. There is no process to probe between runs, so the only
            evidence it is working is the line its cron wrapper writes when it finishes.
          </p>
        </Board>

        <Changelog
          gap={recyclarr.gap}
          span={12}
          aside={
            recyclarr.running.revision === null ?
              <span className="board-note">recyclarr/recyclarr</span>
            : <span className="board-note mono">{recyclarr.running.revision}</span>
          }
          foot={
            <p className="board-foot">
              Recyclarr is pinned to a bare major (<span className="mono">:8</span>) — a channel,
              not a version — prints no banner, exposes no API and logs nothing about itself. This
              page used to say its version could not be established at all. It can: the image
              records it, along with the commit it was built from.
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
