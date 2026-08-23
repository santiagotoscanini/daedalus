import { useState } from 'react'
import type { MediaData } from '../../../lib/dashboard/categories/media'
import { bytes, DASH, flag, num, rate, since, until } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import { compareOf, Open, ServiceHead, SOURCE_NOTE, verdictOf } from '../../service-head'
import { Board, BoardGrid, Chip, Facts, Measures, Progress, Pulse } from '../../viz'
import { ServiceBar, tone, VERSION_SNAPSHOT } from './shared'

/* ── Downloaders: qBittorrent, NZBGet, MeTube, Shelfmark ──────────────── */

type Downloaders = Extract<MediaData, { tab: 'downloaders' }>

export function DownloadersView({ d }: { d: Downloaders }) {
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

      {which === 'qbt' ? (
        <QbtPage d={d} />
      ) : which === 'nzb' ? (
        <NzbPage d={d} />
      ) : which === 'shelfmark' ? (
        <ShelfmarkPage d={d} />
      ) : (
        <MetubePage d={d.metube} />
      )}
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
              vpn.port === null ? (
                <span className="text-bad">not forwarded</span>
              ) : (
                <span className="mono">{vpn.port}</span>
              ),
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
            network namespace, so the forwarded port matters: without one it can download and never
            seed.
          </>
        }
        actions={<Open name="qBittorrent" host="qbittorrent" />}
      />

      <BoardGrid>
        <Board
          title="Transfers"
          icon="down"
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
          {qbt.transfers.length === 0 ? (
            <p className="viz-empty">
              {qbt.reachable
                ? 'Nothing downloading. Completed torrents are removed after import.'
                : 'qBittorrent did not accept the login.'}
            </p>
          ) : (
            <ul className="transfers">
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
          )}
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
                  qbt.counts.stalled === 0 ? (
                    num(0)
                  ) : (
                    <span className="text-warn">{num(qbt.counts.stalled)}</span>
                  ),
              },
              {
                k: 'Errored',
                v:
                  qbt.counts.errored === 0 ? (
                    num(0)
                  ) : (
                    <span className="text-bad">{num(qbt.counts.errored)}</span>
                  ),
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
            it is not. Retention is a property of the provider rather than the release, which is why
            the news-server list is on this page.
          </>
        }
        actions={<Open name="NZBGet" host="nzbget" />}
      />

      <BoardGrid>
        <Board
          title="Downloading"
          icon="down"
          span={8}
          aside={
            <span className="board-note">
              <Pulse on={(nzb.rate ?? 0) > 0} tone="accent" />
              {nzb.paused ? 'paused' : nzb.standby ? 'idle' : 'active'}
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
          {nzb.groups.length === 0 ? (
            <p className="viz-empty">Nothing in the queue.</p>
          ) : (
            <ul className="transfers">
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
          )}
        </Board>

        <TunnelBoard vpn={d.vpn} span={4} />

        <Board
          title="News servers"
          icon="⛁"
          span={4}
          aside={
            inactive === 0 ? (
              <span className="board-note">all active</span>
            ) : (
              <span className="board-note text-bad">{num(inactive)} inactive</span>
            )
          }
        >
          {nzb.servers.length === 0 ? (
            <p className="viz-empty">could not read the server list</p>
          ) : (
            <ul className="provs">
              {nzb.servers.map((s) => (
                <li key={s.id} className="prov">
                  <Chip tone={s.active ? 'ok' : 'bad'}>{s.active ? 'active' : 'inactive'}</Chip>
                  <span className="prov-name mono">server {s.id}</span>
                </li>
              ))}
            </ul>
          )}
          <Facts
            rows={[
              { k: 'Uptime', v: since(nzb.uptimeSeconds) },
              { k: 'Spent downloading', v: since(nzb.downloadSeconds) },
              { k: 'Free where it writes', v: bytes(total) },
            ]}
          />
          <p className="board-foot">
            A provider whose subscription lapses goes inactive and everything stops being found.
            From Sonarr&rsquo;s side that is indistinguishable from the release not existing.
          </p>
        </Board>

        <Changelog
          gap={nzb.gap}
          span={8}
          aside={<span className="board-note">nzbgetcom/nzbget</span>}
        />

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
        compare={compareOf(d.gap, 'the image tag, since MeTube serves no version')}
        lede={
          <>
            yt-dlp with a web form in front of it, and the only downloader here that nothing else
            drives: you point it at a URL yourself. Also inside the VPN namespace, which is
            occasionally why a site refuses it.
          </>
        }
        actions={<Open name="MeTube" host="metube" />}
      />

      <BoardGrid>
        <Board
          title="Queue"
          icon="down"
          span={8}
          aside={
            <span className="board-note">
              {num(d.queued)} queued · {num(d.pending)} pending
            </span>
          }
        >
          {d.recent.length === 0 ? (
            <p className="viz-empty">Nothing downloaded yet.</p>
          ) : (
            <ul className="feed">
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
          )}
          <p className="board-foot">
            The most recent finished items. MeTube keeps its history in the browser session as well
            as on the server, so this list and the one in its own UI can differ.
          </p>
        </Board>

        <Board title="All time" icon="grid" span={4}>
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
              MeTube ships a new dated build most weeks and almost all of them are a yt-dlp bump,
              which is what fixes a site that suddenly stopped downloading. It is the one service on
              this page where being behind is usually the whole explanation.
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
          shelfmark.running.revision === null
            ? 'the image’s OCI label'
            : `the image’s OCI label, built from ${shelfmark.running.revision}`,
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
          icon="down"
          span={8}
          aside={
            counts === null ? (
              <span className="board-note">did not answer</span>
            ) : (
              <span className="board-note">
                {num(counts.done)} completed · {num(counts.errors)} failed
              </span>
            )
          }
        >
          {shelfmark.jobs.length === 0 ? (
            <p className="viz-empty">Queue is empty.</p>
          ) : (
            <ul className="transfers">
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
          )}
        </Board>

        <Board title="Queue" icon="clock" span={4}>
          {counts === null ? (
            <p className="viz-empty">no reading</p>
          ) : (
            <Measures
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
          )}
        </Board>

        <Changelog
          gap={shelfmark.gap}
          span={12}
          aside={
            shelfmark.running.revision === null ? (
              <span className="board-note">calibrain/shelfmark</span>
            ) : (
              <span className="board-note mono">{shelfmark.running.revision}</span>
            )
          }
          foot={
            <p className="board-foot">
              The pin is a moving <span className="mono">:latest</span> by digest, so the tag says
              nothing. The image does: its OCI labels carry the version and the commit it was built
              from, which is what makes this a real gap rather than a list of everything that has
              ever shipped.
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
