import { cn } from '../../../lib/cn'
import type { MediaData } from '../../../lib/dashboard/categories/media'
import { bytes, num } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../service-head'
import { Board, BoardGrid, Chip, Facts, Progress, Pulse, Ring, Trend } from '../../viz'
import { ago, EMPTY, FOOT, LIST, MONO, NOTE } from './shared'

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
            Where everything on this page ends up. Streams from <span className={MONO}>/s2/tv</span>{' '}
            and transcodes on the iGPU. The one media container deliberately outside the VPN, so
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
              <span className={NOTE}>{num(transcoding)} transcoding</span>
            )
          }
        >
          {d.playing.length === 0 ? (
            <p className={EMPTY}>Nobody is watching anything.</p>
          ) : (
            <ul className={`${LIST} gap-[0.8rem]`}>
              {d.playing.map((s, i) => (
                <li key={`${s.user}-${String(i)}`} className="flex flex-col gap-[0.35rem]">
                  <div className="flex min-w-0 flex-wrap items-baseline justify-between gap-[0.7rem]">
                    <span className="flex min-w-0 items-center gap-[0.45rem] truncate font-[550] [&_em]:font-normal [&_em]:text-(--text-muted) [&_em]:not-italic">
                      <Pulse on={!s.paused} tone="ok" />
                      {s.title}
                      {s.sub !== null && <em> — {s.sub}</em>}
                    </span>
                    <span className="flex flex-wrap gap-[0.3rem]">
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
          <p className={FOOT}>
            Only sessions actually playing something. Every poller that has ever asked Jellyfin a
            question holds an idle session for a while afterwards, so the raw list reports an
            audience that is not in the room.
          </p>
        </Board>

        <Board title="Library" icon="grid" span={4}>
          <div className="flex items-center gap-[1.1rem] max-[30rem]:flex-col max-[30rem]:items-start">
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
            {/* The wrapper is what takes the slack beside the ring — `Facts`
                draws its own grid and has no class of its own to stretch. */}
            <div className="min-w-0 flex-auto">
              <Facts
                rows={[
                  { k: 'Movies', v: num(counts.movies) },
                  { k: 'Series', v: num(counts.series) },
                  { k: 'Episodes', v: num(counts.episodes) },
                  { k: 'Free on pool', v: bytes(library.freeBytes) },
                ]}
              />
            </div>
          </div>
          <h4 className="mt-[0.35rem] mb-[-0.2rem] text-[0.73rem] font-[550] tracking-normal text-muted-foreground">
            Growth, 30 days
          </h4>
          <Trend values={library.growth} tone="info" height={70} />
        </Board>

        <Board
          title="Who watches"
          icon="◍"
          span={4}
          aside={<span className={NOTE}>{num(d.people.length)} accounts</span>}
        >
          {d.people.length === 0 ? (
            <p className={EMPTY}>could not read the user list</p>
          ) : (
            <ul className={`${LIST} gap-[0.25rem]`}>
              {d.people.map((p) => (
                <li
                  key={p.name}
                  className="flex items-baseline justify-between gap-[0.7rem] text-[0.82rem]"
                >
                  <span>{p.name}</span>
                  <span
                    className={cn(
                      'text-[0.75rem] text-muted-foreground',
                      p.lastSeenDays !== null && p.lastSeenDays > STALE_DAYS && 'opacity-55',
                    )}
                  >
                    {ago(p.lastSeenDays)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            Last activity, not last login. A client that stays signed in reports the second one once
            and never again, which is why an account in daily use can show a login from May.
          </p>
        </Board>

        <Changelog
          gap={d.gap}
          span={8}
          aside={
            d.pendingRestart ? (
              <span className={cn(NOTE, 'text-warning')}>restart pending</span>
            ) : (
              <span className={NOTE}>github</span>
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
              note: 'The only reader of the render node Jellyfin transcodes on, and the only container on this box with no page of its own. Its metrics (gpumon_engine_usage, gpumon_power) are scraped and nothing here draws them yet. When a transcode is slow and Jellyfin’s own log says only that ffmpeg took a while, this is where "was the GPU busy or was it not being used at all" is answered. i915 is force-probed via a kernel param; a driver that failed to bind shows up here first.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}
