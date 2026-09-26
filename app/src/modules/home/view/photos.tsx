import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Board, BoardGrid, Facts, Measures, Progress, Ring } from '../../../components/viz'
import { bytes, num, pct } from '../../../lib/format'
import type { HomeData } from '../data'
import { LIST, MAIN, NUM, SIDE } from './shared'

// Home › Photos: Immich — the library's split, the dataset under it, and who
// is backing up.

type Photos = Extract<HomeData, { tab: 'photos' }>

export function PhotosView({ data: d }: { data: Photos }) {
  const total = (d.photos ?? 0) + (d.videos ?? 0)

  return (
    <>
      <ServiceHead
        logo="/icon-immich.svg"
        name="Immich"
        version={d.version}
        versionNote="reported by the server"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/server/version')}
        lede={
          <>
            The photo and video library. Every phone in the house backs up here, and it is where the
            pictures moved to when Nextcloud stopped being the place for them.
          </>
        }
        actions={<Open name="Immich" host="immich" />}
      />

      <BoardGrid>
        <Board
          title="Library"
          icon="◨"
          span={8}
          aside={<span className={NOTE}>{num(total)} items</span>}
        >
          <div className="flex items-center gap-[1.1rem] max-[30rem]:flex-col max-[30rem]:items-start [&>dl]:flex-auto">
            {/* The ring is the split between stills and video, which IS a
                whole this data describes — unlike library size, which has no
                honest denominator here. */}
            <Ring
              pct={total === 0 ? null : ((d.photos ?? 0) / total) * 100}
              value={num(d.photos)}
              label="stills"
              tone="info"
            />
            <Facts
              rows={[
                { k: 'Videos', v: num(d.videos) },
                { k: 'Stills on disk', v: bytes(d.usagePhotos) },
                { k: 'Video on disk', v: bytes(d.usageVideos) },
                { k: 'Library total', v: bytes(d.usageBytes) },
              ]}
            />
          </div>
          <p className={FOOT}>
            Video is{' '}
            {pct(
              d.usageBytes === null || d.usageBytes === 0
                ? null
                : ((d.usageVideos ?? 0) / d.usageBytes) * 100,
            )}{' '}
            of what is stored and {pct(total === 0 ? null : ((d.videos ?? 0) / total) * 100)} of
            what is in it. That ratio decides how fast this dataset grows.
          </p>
        </Board>

        <Board title="Disk" icon="grid" span={4}>
          <Progress
            pct={
              d.disk.usedBytes === null || d.disk.freeBytes === null
                ? null
                : (d.disk.usedBytes / (d.disk.usedBytes + d.disk.freeBytes)) * 100
            }
            tone="info"
          />
          <Measures
            items={[
              { k: 'used', v: bytes(d.disk.usedBytes) },
              { k: 'free', v: bytes(d.disk.freeBytes) },
            ]}
          />
          <p className={FOOT}>
            The <span className={MONO}>/s2/immich</span> dataset, read from node_exporter.
            Immich&rsquo;s own storage endpoint needs a permission this API key does not carry, and
            the dataset underneath is the same disk. Hourly, daily and weekly snapshots; on the
            mirror, so a single drive failure costs nothing.
          </p>
        </Board>

        <Board title="Who is backing up" icon="◑" span={4}>
          <ul className={LIST}>
            {d.users.map((u) => (
              <li key={u.name}>
                <span className={MAIN}>{u.name}</span>
                <span className={SIDE}>
                  {num(u.photos)} + {num(u.videos)} video
                </span>
                <span className={NUM}>{bytes(u.usageBytes)}</span>
              </li>
            ))}
          </ul>
          {d.users.length === 0 && <p className={EMPTY}>could not read the user list</p>}
          <p className={FOOT}>
            Quotas are unset on every account, so the only ceiling is the dataset above.
          </p>
        </Board>

        <Changelog gap={d.gap} span={8} />

        <LogBoard
          source={{ stack: 'immich' }}
          title="Immich logs"
          foot={
            <p className={FOOT}>
              The whole stack rather than one container: the server, the machine-learning worker
              that does face and object recognition, and its Redis. A backup that appears to hang is
              usually the ML worker, which logs there and nowhere else.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}
