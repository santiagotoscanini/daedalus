import type { MediaData } from '../../../lib/dashboard/categories/media'
import { bytes, num } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../service-head'
import { Board, BoardGrid, Chip, Facts, Progress, Pulse, Ring, Trend } from '../../viz'
import { ago } from './shared'

/* ── Jellyfin ─────────────────────────────────────────────────────────── */

/** Idle longer than this and an account is worth noticing rather than listing. */
const STALE_DAYS = 60

export function JellyfinView({ d }: { d: Extract<MediaData, { tab: 'jellyfin' }> }) {
  const { library, counts } = d
  const total =
    library.usedBytes !== null && library.freeBytes !== null
      ? library.usedBytes + library.freeBytes
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
            transcoding === 0 ? undefined : (
              <span className="board-note">{num(transcoding)} transcoding</span>
            )
          }
        >
          {d.playing.length === 0 ? (
            <p className="viz-empty">Nobody is watching anything.</p>
          ) : (
            <ul className="playing">
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
          )}
          <p className="board-foot">
            Only sessions actually playing something. Every poller that has ever asked Jellyfin a
            question holds an idle session for a while afterwards, so the raw list reports an
            audience that is not in the room.
          </p>
        </Board>

        <Board title="Library" icon="grid" span={4}>
          <div className="library-split">
            <Ring
              pct={
                total === null || library.usedBytes === null
                  ? null
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
          {d.people.length === 0 ? (
            <p className="viz-empty">could not read the user list</p>
          ) : (
            <ul className="who">
              {d.people.map((p) => (
                <li key={p.name} className="who-row">
                  <span className="who-name">{p.name}</span>
                  <span
                    className={
                      p.lastSeenDays !== null && p.lastSeenDays > STALE_DAYS
                        ? 'who-when is-muted'
                        : 'who-when'
                    }
                  >
                    {ago(p.lastSeenDays)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="board-foot">
            Last activity, not last login — a client that stays signed in reports the second one
            once and never again, which is why an account in daily use can show a login from May.
          </p>
        </Board>

        <Changelog
          gap={d.gap}
          span={8}
          aside={
            d.pendingRestart ? (
              <span className="board-note text-warn">restart pending</span>
            ) : (
              <span className="board-note">github</span>
            )
          }
        />

        <LogBoard
          source={{ container: 'jellyfin' }}
          title="Jellyfin logs"
          neighbours={[
            {
              source: { container: 'intel-gpu-exporter' },
              label: 'intel-gpu-exporter',
              role: 'what the iGPU is actually doing',
              note: 'The only reader of the render node Jellyfin transcodes on, and the only container on this box with no page of its own — its metrics (gpumon_engine_usage, gpumon_power) are scraped and nothing here draws them yet. When a transcode is slow and Jellyfin’s own log says only that ffmpeg took a while, this is where "was the GPU busy or was it not being used at all" is answered. i915 is force-probed via a kernel param; a driver that failed to bind shows up here first.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}
