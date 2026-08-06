import {
  BarList,
  Board,
  BoardGrid,
  BigStat,
  Chip,
  Facts,
  Flow,
  Progress,
  Pulse,
  Ring,
  StatBand,
  Trend,
} from '../viz'
import { DASH, bytes, flag, num, rate, until } from '../../lib/dashboard/format'
import type { BooksData, TvData } from '../../server/category'

// The Media page, TV sub-tab.
//
// Built around the pipeline rather than around the services, because the
// services are only interesting when work is stuck between two of them. The
// order down the page is the order a file actually travels: someone asks
// (Seerr) → indexers are searched (Prowlarr) → something downloads
// (qBittorrent/NZBGet) → the *arrs import it → Jellyfin plays it.

export function TvView({ data }: { data: TvData }) {
  const { speed, pipeline, library, wanted, vpn } = data
  const moving = (speed.down ?? 0) + (speed.up ?? 0) > 0
  const libraryTotal =
    library.usedBytes !== null && library.freeBytes !== null ?
      library.usedBytes + library.freeBytes
    : null

  return (
    <>
      <StatBand>
        <BigStat
          label="Down"
          value={speed.down === null ? DASH : bytes(speed.down)}
          unit="/s"
          tone={moving ? 'accent' : 'muted'}
          sub={
            <>
              <Pulse on={moving} tone="accent" />
              {speed.sessionDown === null ? 'session' : `${bytes(speed.sessionDown)} this session`}
            </>
          }
        />
        <BigStat
          label="Up"
          value={speed.up === null ? DASH : bytes(speed.up)}
          unit="/s"
          tone="info"
          sub={speed.sessionUp === null ? 'session' : `${bytes(speed.sessionUp)} this session`}
        />
        <BigStat
          label="Playing now"
          value={num(data.nowPlaying.length)}
          tone={data.nowPlaying.length > 0 ? 'ok' : 'muted'}
          sub={data.nowPlaying.length === 0 ? 'nobody watching' : 'streams'}
        />
        <BigStat
          label="Library"
          value={bytes(library.usedBytes)}
          tone="info"
          sub={`${bytes(library.freeBytes)} free on the pool`}
        />
      </StatBand>

      <BoardGrid>
        <Board title="Pipeline" icon="⇉" span={12}>
          <Flow
            steps={[
              {
                label: 'Indexers',
                value: num(pipeline.indexers),
                hint: 'enabled in Prowlarr',
                active: (pipeline.indexers ?? 0) > 0,
              },
              {
                label: 'Wanted',
                value: num(pipeline.wanted),
                hint: 'missing from the library',
                active: (pipeline.wanted ?? 0) > 0,
              },
              {
                label: 'Downloading',
                value: num(pipeline.downloading),
                hint: 'torrents + usenet',
                active: pipeline.downloading > 0,
              },
              {
                label: 'Importing',
                value: num(pipeline.importing),
                hint: 'in the *arr queues',
                active: (pipeline.importing ?? 0) > 0,
              },
              {
                label: 'Library',
                value: num(pipeline.library),
                hint: 'movies + episodes',
                active: (pipeline.library ?? 0) > 0,
              },
            ]}
          />
        </Board>

        {data.nowPlaying.length > 0 && (
          <Board title="Now playing" icon="▶" span={12}>
            <ul className="playing">
              {data.nowPlaying.map((s, i) => (
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
                  <Progress pct={s.pct} tone={s.paused ? 'muted' : 'ok'} active={!s.paused} height={8} />
                </li>
              ))}
            </ul>
          </Board>
        )}

        <Board
          title="Transfers"
          icon="⇣"
          span={8}
          aside={
            <span className="board-note">
              {speed.connection ?? DASH}
              {speed.paused && ' · usenet paused'}
            </span>
          }
        >
          {data.transfers.length === 0 && data.usenet.length === 0 ?
            <p className="viz-empty">
              Nothing downloading. Completed torrents are removed after import.
            </p>
          : <ul className="transfers">
              {data.transfers.map((t) => (
                <li key={t.name} className="transfers-row">
                  <div className="transfers-head">
                    <span className="transfers-name" title={t.name}>
                      {t.name}
                    </span>
                    <span className="transfers-meta">
                      {t.active && <>{rate(t.down)} · </>}
                      {t.pct.toFixed(0)}% of {bytes(t.size)}
                      {t.etaSeconds !== null && <> · {until(t.etaSeconds)} left</>}
                    </span>
                  </div>
                  <Progress pct={t.pct} tone={t.active ? 'accent' : 'muted'} active={t.active} />
                </li>
              ))}
              {data.usenet.map((u) => (
                <li key={u.name} className="transfers-row">
                  <div className="transfers-head">
                    <span className="transfers-name" title={u.name}>
                      {u.name}
                    </span>
                    <span className="transfers-meta">
                      {u.pct.toFixed(0)}% · {bytes(u.remainingBytes)} left
                    </span>
                  </div>
                  <Progress pct={u.pct} tone="info" active={!speed.paused} />
                </li>
              ))}
            </ul>
          }
        </Board>

        <Board title="Tunnel" icon="⛨" span={4}>
          <div className="vpn-state">
            <Pulse on={vpn.up === true} tone={vpn.up === true ? 'ok' : 'bad'} />
            <strong>{vpn.up === null ? 'unknown' : vpn.up ? 'connected' : 'down'}</strong>
          </div>
          <Facts
            rows={[
              { k: 'Exit', v: flag(vpn.country) },
              { k: 'City', v: vpn.city ?? DASH },
              { k: 'Public IP', v: <span className="mono">{vpn.ip ?? DASH}</span> },
              {
                k: 'Forwarded port',
                // The port is the signal that torrents can actually seed. A
                // tunnel that is up but lost its forward looks healthy and is
                // not, which is why it gets called out rather than shown as 0.
                v:
                  vpn.port === null ?
                    <span className="text-bad">not forwarded</span>
                  : <span className="mono">{vpn.port}</span>,
              },
            ]}
          />
        </Board>

        <Board title="Library" icon="▦" span={6}>
          <div className="library-split">
            <Ring
              pct={
                libraryTotal === null || library.usedBytes === null ?
                  null
                : (library.usedBytes / libraryTotal) * 100
              }
              value={bytes(library.usedBytes)}
              label="/s2/tv"
              tone="info"
            />
            <Facts
              rows={[
                { k: 'Movies', v: num(library.movies) },
                { k: 'Series', v: num(library.series) },
                { k: 'Episodes', v: num(library.episodes) },
                { k: 'Free on pool', v: bytes(library.freeBytes) },
              ]}
            />
          </div>
          <h4 className="board-sub">Growth, 30 days</h4>
          <Trend values={library.growth} tone="info" height={70} />
        </Board>

        <Board title="Still wanted" icon="◷" span={6}>
          <Facts
            rows={[
              { k: 'Missing episodes', v: num(wanted.episodes) },
              { k: 'Missing movies', v: num(wanted.movies) },
              { k: 'Episodes without subs', v: num(wanted.subtitleEpisodes) },
              { k: 'Movies without subs', v: num(wanted.subtitleMovies) },
            ]}
          />
          <h4 className="board-sub">Grabs by indexer</h4>
          <BarList
            items={data.indexers.map((i) => ({ label: i.label, value: i.value }))}
            empty="no grabs recorded"
          />
        </Board>

        <Board
          title="Housekeeping"
          icon="⌫"
          span={12}
          aside={<span className="board-note">Cleanuparr, last 7 days</span>}
        >
          <div className="metric-pair metric-pair-3">
            <BigStat label="Stuck items removed" value={num(data.cleanup.removed)} tone="warn" />
            <BigStat label="Blocked (kept returning)" value={num(data.cleanup.blocked)} tone="bad" />
            <BigStat label="Replacement searches" value={num(data.cleanup.searches)} tone="ok" />
          </div>
          {/* Cleanuparr publishes no metrics and 2.10.1 closed the API that
              used to report this, so these are counted out of its log lines. */}
          <p className="board-foot">Counted from Cleanuparr&rsquo;s own log lines in Loki.</p>
        </Board>
      </BoardGrid>
    </>
  )
}

/* ── Books ────────────────────────────────────────────────────────────── */

export function BooksView({ data }: { data: BooksData }) {
  const { library, counts } = data

  return (
    <>
      <StatBand>
        <BigStat label="Books" value={num(library.books)} sub="in Calibre-Web" />
        <BigStat label="Authors" value={num(library.authors)} tone="info" />
        <BigStat label="Series" value={num(library.series)} tone="ok" />
        <BigStat
          label="On disk"
          value={bytes(library.usedBytes)}
          tone="muted"
          sub="under /s2/books"
        />
      </StatBand>

      <BoardGrid>
        <Board
          title="Downloads"
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
          {data.jobs.length === 0 ?
            <p className="viz-empty">Queue is empty.</p>
          : <ul className="transfers">
              {data.jobs.map((j, i) => (
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
          : <Facts
              rows={[
                { k: 'Downloading', v: num(counts.downloading) },
                { k: 'Queued', v: num(counts.queued) },
                { k: 'Completed', v: num(counts.done) },
                { k: 'Errors', v: num(counts.errors) },
              ]}
            />
          }
          <p className="board-foot">
            Shelfmark searches Anna&rsquo;s Archive through the downloads stack&rsquo;s VPN and
            hands finished files to Calibre-Web.
          </p>
        </Board>

        <Board title="Shelf" icon="❏" span={12}>
          <Facts
            rows={[
              { k: 'Books', v: num(library.books) },
              { k: 'Authors', v: num(library.authors) },
              { k: 'Series', v: num(library.series) },
              { k: 'Categories', v: num(library.categories) },
            ]}
          />
        </Board>
      </BoardGrid>
    </>
  )
}
