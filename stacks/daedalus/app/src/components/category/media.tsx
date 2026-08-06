import { Board, BoardGrid, Chip, Facts, Measures, Progress, Pulse, RankRow, Ring, Trend } from '../viz'
import { LogBoard, type LogNeighbour } from '../logs'
import { Changelog } from '../release-notes'
import { ServiceHead, verdictOf, type CompareRow } from '../service-head'
import { DASH, bytes, flag, num, rate, until } from '../../lib/dashboard/format'
import type { VersionGap } from '../../lib/dashboard/github'
import type { MediaData } from '../../server/category'

// The Media pages — one per service, chosen by the sub-tab.
//
// Same opening as the AI and Gaming tabs, and for the same reason: artwork, the
// name, the version running, the verdict on whether that version is current,
// one sentence saying where this service sits in the chain, and the link you
// came to click. Nine services whose UIs look nothing alike become nine pages
// that are read the same way.
//
// Underneath, each is its own thing, and the differences are the point. The
// *arrs are about work that is stuck; Prowlarr is about which indexer is
// carrying the search; the downloaders are about what is moving right now;
// Cleanup is about three timers nobody watches. Forcing those into a shared
// layout is what the tile directory did, and it is why every service got three
// numbers that answered no question anybody actually had.

export function MediaView({ data }: { data: MediaData }) {
  switch (data.tab) {
    case 'jellyfin':
      return <JellyfinView d={data} />
    case 'seerr':
      return <SeerrView d={data} />
    case 'sonarr':
    case 'radarr':
      return <ArrView d={data} />
    case 'prowlarr':
      return <ProwlarrView d={data} />
    case 'bazarr':
      return <BazarrView d={data} />
    case 'downloads':
      return <DownloadsView d={data} />
    case 'books':
      return <BooksView d={data} />
    case 'cleanup':
      return <CleanupView d={data} />
  }
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
        actions={
          <a className="btn btn-primary" href="https://jellyfin.toscanini.me" target="_blank" rel="noreferrer">
            Open Jellyfin ↗
          </a>
        }
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
                  <span className={p.lastSeenDays !== null && p.lastSeenDays > STALE_DAYS ? 'who-when is-muted' : 'who-when'}>
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

/* ── Seerr ────────────────────────────────────────────────────────────── */

function SeerrView({ d }: { d: Extract<MediaData, { tab: 'seerr' }> }) {
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
            hands it to Radarr or Sonarr — everything else on this page is what happens next.
          </>
        }
        actions={
          <a className="btn btn-primary" href="https://seerr.toscanini.me" target="_blank" rel="noreferrer">
            Open Seerr ↗
          </a>
        }
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
              { k: 'Pending', v: num(counts.pending), tone: (counts.pending ?? 0) > 0 ? 'warn' : undefined },
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

        <LogBoard source={{ container: 'seerr' }} title="Seerr logs" />
      </BoardGrid>
    </>
  )
}

/* ── Sonarr and Radarr ────────────────────────────────────────────────── */

/**
 * The words that differ between the two, and nothing else.
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
    url: 'https://sonarr.toscanini.me',
    lede: 'Watches series for new episodes, asks Prowlarr where to find them, and hands what it finds to a downloader. What arrives is renamed into /s2/tv and Jellyfin picks it up.',
    upcoming: 'Airing next',
  },
  radarr: {
    name: 'Radarr',
    logo: '/icon-radarr.svg',
    unit: 'Movies',
    url: 'https://radarr.toscanini.me',
    lede: 'The same program as Sonarr, pointed at films. Same indexers, same downloaders, same folder — the difference is that a film has a release date rather than a schedule.',
    upcoming: 'Releasing next',
  },
} as const

function ArrView({ d }: { d: Extract<MediaData, { tab: 'sonarr' | 'radarr' }> }) {
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
        actions={
          <a className="btn btn-primary" href={copy.url} target="_blank" rel="noreferrer">
            Open {copy.name} ↗
          </a>
        }
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
                pct={disk.totalBytes > 0 ? ((disk.totalBytes - disk.freeBytes) / disk.totalBytes) * 100 : null}
                tone="info"
              />
              <p className="board-foot">{bytes(disk.freeBytes)} free of {bytes(disk.totalBytes)}</p>
            </div>
          ))}
        </Board>

        <Board
          title="Queue"
          icon="⇣"
          span={8}
          aside={<span className="board-note">{num(counts.queued)} item{counts.queued === 1 ? '' : 's'}</span>}
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

        <LogBoard source={{ container: d.app }} title={`${copy.name} logs`} />
      </BoardGrid>
    </>
  )
}

/* ── Prowlarr ─────────────────────────────────────────────────────────── */

/**
 * flaresolverr has no page anywhere and no API this box can reach — it lives
 * inside gluetun's netns with no published port — so its log is the only thing
 * that can be said about it, and Prowlarr is the only tab where it means
 * anything.
 */
const PROWLARR_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    container: 'flaresolverr',
    label: 'FlareSolverr',
    role: 'the browser that answers Cloudflare challenges',
    note: 'Indexers behind a Cloudflare challenge are searched through this. When one of them starts failing every query while the others are fine, this log says whether the challenge was refused or the browser never started — Prowlarr itself only records that the request timed out.',
  },
]

function ProwlarrView({ d }: { d: Extract<MediaData, { tab: 'prowlarr' }> }) {
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
        actions={
          <a className="btn btn-primary" href="https://prowlarr.toscanini.me" target="_blank" rel="noreferrer">
            Open Prowlarr ↗
          </a>
        }
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

/* ── Bazarr ───────────────────────────────────────────────────────────── */

const BAZARR_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    container: 'subgen',
    label: 'Subgen',
    role: 'Whisper, for the subtitles nobody published',
    note: 'Registered with Bazarr as the `whisperai` provider. When an episode has no subtitles anywhere, this transcribes the audio instead — on the CPU, so a single film can take a long time and the only evidence it is working is here.',
  },
]

function BazarrView({ d }: { d: Extract<MediaData, { tab: 'bazarr' }> }) {
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
        actions={
          <a className="btn btn-primary" href="https://bazarr.toscanini.me" target="_blank" rel="noreferrer">
            Open Bazarr ↗
          </a>
        }
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

/* ── Downloads ────────────────────────────────────────────────────────── */

const DOWNLOAD_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    container: 'nzbget',
    label: 'NZBGet',
    role: 'the usenet half',
    note: 'Failures here are article-level and silent: a post that has been incompletely retained downloads to 99% and then fails to assemble, which the *arrs record only as an import that never happened.',
  },
  {
    container: 'metube',
    label: 'MeTube',
    role: 'yt-dlp, by hand',
    note: 'The only downloader here nothing else drives. Almost every failure is yt-dlp being out of date against a site that changed, which looks like a broken URL until you read it.',
  },
]

function DownloadsView({ d }: { d: Extract<MediaData, { tab: 'downloads' }> }) {
  const { qbt, nzb, metube, vpn } = d
  const moving = (qbt.down ?? 0) + (qbt.up ?? 0) + (nzb.rate ?? 0) > 0

  return (
    <>
      <ServiceHead
        logo="/icon-qbittorrent.svg"
        name="Downloads"
        version={qbt.version}
        versionNote="qBittorrent"
        verdict={verdictOf(qbt.gap)}
        compare={compareOf(qbt.gap, 'from /api/v2/app/version')}
        lede={
          <>
            Three downloaders doing one job. qBittorrent and NZBGet are fed by the *arrs and land in
            the same folder; MeTube is the manual one. All three run inside gluetun&rsquo;s network
            namespace, so every byte on this page crossed the ProtonVPN tunnel.
          </>
        }
        actions={
          <a className="btn btn-primary" href="https://qbittorrent.toscanini.me" target="_blank" rel="noreferrer">
            Open qBittorrent ↗
          </a>
        }
      />

      <BoardGrid>
        <Board
          title="Moving now"
          icon="⇣"
          span={8}
          aside={
            <span className="board-note">
              <Pulse on={moving} tone="accent" />
              {qbt.connection ?? DASH}
              {nzb.paused && ' · usenet paused'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'Torrent down', v: rate(qbt.down) },
              { k: 'Torrent up', v: rate(qbt.up) },
              { k: 'Usenet', v: rate(nzb.rate) },
              { k: 'Session', v: `${bytes(qbt.sessionDown)} in · ${bytes(qbt.sessionUp)} out` },
              { k: 'Free', v: bytes(qbt.freeBytes) },
            ]}
          />
          {qbt.transfers.length === 0 && nzb.groups.length === 0 ?
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

        <Board title="The tunnel" icon="⛨" span={4}>
          <div className="vpn-state">
            <Pulse on={vpn.up === true} tone={vpn.up === true ? 'ok' : 'bad'} />
            <strong>{vpn.up === null ? 'unknown' : vpn.up ? 'connected' : 'down'}</strong>
          </div>
          <Facts
            rows={[
              { k: 'Exit', v: flag(vpn.country) },
              {
                k: 'Forwarded port',
                // A tunnel that is up but has lost its forward looks perfectly
                // healthy and cannot seed, which is why this is called out
                // rather than shown as a zero.
                v:
                  vpn.port === null ?
                    <span className="text-bad">not forwarded</span>
                  : <span className="mono">{vpn.port}</span>,
              },
              {
                k: 'Torrents',
                v: `${num(qbt.counts.leeching)} down · ${num(qbt.counts.seeding)} seeding`,
              },
              {
                k: 'Stalled',
                v:
                  qbt.counts.stalled + qbt.counts.errored === 0 ?
                    num(0)
                  : <span className="text-warn">
                      {num(qbt.counts.stalled)}
                      {qbt.counts.errored > 0 && ` · ${num(qbt.counts.errored)} errored`}
                    </span>,
              },
            ]}
          />
          <p className="board-foot">
            Three facts, not a panel: the tunnel has a page of its own on Network › Going out. What
            belongs here is the part that silently changes what this tab reports.
          </p>
        </Board>

        <Board
          title="Usenet"
          icon="⁙"
          span={6}
          aside={
            nzb.version === null ?
              <span className="board-note">not answering</span>
            : <span className="board-note mono">{nzb.version}</span>
          }
        >
          <Measures
            items={[
              { k: 'Rate', v: rate(nzb.rate) },
              { k: 'Remaining', v: bytes(nzb.remainingBytes) },
              { k: 'Downloaded', v: bytes(nzb.downloadedBytes) },
              {
                k: 'Failed articles',
                v: num(nzb.articleFailures),
                tone: (nzb.articleFailures ?? 0) > 0 ? 'warn' : undefined,
              },
            ]}
          />
          <p className="board-foot">
            Failed articles are the number that explains a usenet download which reached 99% and
            then vanished: the post was incompletely retained, and no amount of retrying fixes it.
          </p>
        </Board>

        <Board
          title="MeTube"
          icon="▷"
          span={6}
          aside={
            <span className="board-note">
              {num(metube.queued)} queued · {num(metube.done)} done
            </span>
          }
        >
          {metube.recent.length === 0 ?
            <p className="viz-empty">nothing downloaded yet</p>
          : <ul className="feed">
              {metube.recent.map((r, i) => (
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
        </Board>

        <Changelog
          gap={nzb.gap}
          span={6}
          title={
            nzb.gap.behind.length === 0 ?
              'NZBGet — current'
            : `NZBGet — ${String(nzb.gap.behind.length)} behind`
          }
          aside={<span className="board-note">nzbgetcom/nzbget</span>}
        />
        <Changelog
          gap={metube.gap}
          span={6}
          title={
            metube.gap.behind.length === 0 ?
              'MeTube — current'
            : `MeTube — ${String(metube.gap.behind.length)} behind`
          }
          aside={
            metube.version === null ?
              <span className="board-note">version unknown</span>
            : <span className="board-note mono">{metube.version}</span>
          }
          foot={
            <p className="board-foot">
              MeTube ships a new dated build most weeks, and almost all of them are a yt-dlp bump —
              which is exactly what fixes a site that suddenly stopped downloading.
            </p>
          }
        />

        <Changelog gap={qbt.gap} span={12} aside={<span className="board-note">qBittorrent</span>} />

        <LogBoard
          source={{ container: 'qbittorrent' }}
          title="qBittorrent logs"
          neighbours={DOWNLOAD_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}

/* ── Books ────────────────────────────────────────────────────────────── */

const BOOK_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    container: 'shelfmark',
    label: 'Shelfmark',
    role: 'the search and download half',
    note: 'Searches Anna’s Archive through the downloads stack’s VPN and drops finished files where Calibre-Web-Automated ingests them. A book that never appears has usually failed here, not in the library.',
  },
]

function BooksView({ d }: { d: Extract<MediaData, { tab: 'books' }> }) {
  const { calibre, shelfmark, disk } = d
  const counts = shelfmark.counts

  return (
    <>
      <ServiceHead
        logo="/icon-calibre-web.svg"
        name="Books"
        version={calibre.version}
        versionNote="Calibre-Web-Automated"
        verdict={verdictOf(calibre.gap)}
        compare={compareOf(calibre.gap, 'from the tag the flake pins')}
        lede={
          <>
            Two halves of one shelf: Shelfmark finds and downloads, Calibre-Web-Automated ingests and
            serves. Everything lives under <span className="mono">/s2/books</span>.
          </>
        }
        actions={
          <a className="btn btn-primary" href="https://calibre.toscanini.me" target="_blank" rel="noreferrer">
            Open Calibre-Web ↗
          </a>
        }
      />

      <BoardGrid>
        <Board
          title="Downloading"
          icon="⇣"
          span={8}
          aside={
            counts === null ?
              <span className="board-note">Shelfmark did not answer</span>
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

        <Board title="The shelf" icon="❏" span={4}>
          <Facts
            rows={[
              { k: 'Books', v: num(calibre.books) },
              { k: 'Authors', v: num(calibre.authors) },
              { k: 'Series', v: num(calibre.series) },
              { k: 'Categories', v: num(calibre.categories) },
              { k: 'On disk', v: bytes(disk.usedBytes) },
              { k: 'Free', v: bytes(disk.freeBytes) },
            ]}
          />
          {counts !== null && (
            <Measures
              items={[
                { k: 'Downloading', v: num(counts.downloading) },
                { k: 'Queued', v: num(counts.queued) },
                {
                  k: 'Errors',
                  v: num(counts.errors),
                  tone: counts.errors > 0 ? 'warn' : undefined,
                },
              ]}
            />
          )}
        </Board>

        <Changelog gap={calibre.gap} span={6} aside={<span className="board-note">Calibre-Web</span>} />
        <Changelog
          gap={shelfmark.gap}
          span={6}
          title="Shelfmark releases"
          aside={<span className="board-note">version unknown</span>}
          foot={
            <p className="board-foot">
              Shelfmark is pinned by digest to a moving <span className="mono">:latest</span>, so
              nothing here can say which of these it is running — only what has shipped. Its
              container is restarted by a re-pull, not by a version bump.
            </p>
          }
        />

        <LogBoard
          source={{ container: 'calibre-web' }}
          title="Calibre-Web logs"
          neighbours={BOOK_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}

/* ── Cleanup ──────────────────────────────────────────────────────────── */

const CLEANUP_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    container: 'janitorr',
    label: 'Janitorr',
    role: 'retention, in dry-run',
    note: 'Configured to delete nothing. Every line about a deletion is what it WOULD have removed, which makes this log the whole of its output — there is no other evidence it ran.',
  },
  {
    container: 'recyclarr',
    label: 'Recyclarr',
    role: 'TRaSH quality profiles, on a timer',
    note: 'Writes custom formats and scoring into Sonarr and Radarr on a schedule. When a profile mysteriously changes back after you edited it by hand, this is what did it.',
  },
]

function CleanupView({ d }: { d: Extract<MediaData, { tab: 'cleanup' }> }) {
  const { cleanuparr, janitorr, recyclarr } = d
  const window = `last ${String(d.days)} days`

  return (
    <>
      <ServiceHead
        logo="/icon-cleanuparr.png"
        name="Housekeeping"
        version={cleanuparr.version}
        versionNote="Cleanuparr"
        verdict={verdictOf(cleanuparr.gap)}
        compare={compareOf(cleanuparr.gap, 'from the tag the flake pins')}
        lede={
          <>
            Three timers that act on the library rather than filling it: Cleanuparr unsticks the
            download queues, Janitorr watches retention, Recyclarr keeps the quality profiles
            honest. None of them has a screen you would open unprompted, which is why they are here.
          </>
        }
        actions={
          <a className="btn btn-primary" href="https://cleanuparr.toscanini.me" target="_blank" rel="noreferrer">
            Open Cleanuparr ↗
          </a>
        }
      />

      <BoardGrid>
        <Board title="Cleanuparr" icon="⌫" span={8} aside={<span className="board-note">{window}</span>}>
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

        <Board
          title="Janitorr"
          icon="⌦"
          span={4}
          aside={
            janitorr.version === null ?
              <span className="board-note">version unknown</span>
            : <span className="board-note mono">{janitorr.version}</span>
          }
        >
          <Measures items={[{ k: `Would delete, ${window}`, v: num(janitorr.wouldDelete) }]} />
          <p className="board-foot">
            Dry-run — nothing is deleted, so this is what it decided it would remove if it were
            armed. The image is pinned to a moving <span className="mono">jvm-stable</span>, which
            carries no version; the number beside the title is the one Janitorr itself printed when
            it last started.
          </p>
        </Board>

        <Board
          title="Recyclarr"
          icon="⟳"
          span={4}
          aside={
            recyclarr.lastRun === null ?
              <span className="board-note">no run recorded</span>
            : <span className={recyclarr.lastRun.ok ? 'board-note' : 'board-note text-bad'}>
                {recyclarr.lastRun.ok ? 'last run ok' : 'last run failed'}
              </span>
          }
        >
          <Measures
            items={[
              { k: 'Last sync', v: recyclarr.lastRun?.day ?? DASH },
              {
                k: `Errors, ${window}`,
                v: num(recyclarr.errors),
                tone: (recyclarr.errors ?? 0) > 0 ? 'warn' : undefined,
              },
            ]}
          />
          <p className="board-foot">
            Runs nightly and writes TRaSH custom formats and scoring straight into Sonarr and
            Radarr. It has no API, no metrics and no interface, so whether it ran is read out of the
            one line its cron wrapper logs.
          </p>
        </Board>

        <Changelog gap={cleanuparr.gap} span={6} aside={<span className="board-note">Cleanuparr</span>} />
        <Changelog
          gap={janitorr.gap}
          span={6}
          title={
            janitorr.gap.behind.length === 0 ?
              'Janitorr — current'
            : `Janitorr — ${String(janitorr.gap.behind.length)} behind`
          }
          aside={<span className="board-note">Schaka/janitorr</span>}
        />

        <Changelog
          gap={recyclarr.gap}
          span={12}
          title="Recyclarr releases"
          aside={<span className="board-note">version unknown</span>}
          foot={
            <p className="board-foot">
              What has shipped, not what is pending. Recyclarr is pinned to a bare major (
              <span className="mono">:8</span>) — a channel, not a version — and prints its own
              nowhere this box can read, so it is the one service here whose running version cannot
              be established at all.
            </p>
          }
        />

        <LogBoard
          source={{ container: 'cleanuparr' }}
          title="Cleanuparr logs"
          neighbours={CLEANUP_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}

