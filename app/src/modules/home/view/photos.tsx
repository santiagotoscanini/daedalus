import { LogBoard } from '../../../components/logs'
import {
  BOARD_TABLE,
  BOARD_TABLE_HEAD,
  BOARD_TABLE_ROW,
  NUM_CELL,
} from '../../../components/modules/parts'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { CELL_NAME, CELL_QUIET } from '../../../components/table'
import { CAPTION, EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Board, BoardGrid, Facts, Measures, Progress, Ring } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, num, pct } from '../../../lib/format'
import type { HomeData } from '../data'

// Home › Photos: Immich — the library's split, who is backing up, and the
// dataset under it.

type Photos = Extract<HomeData, { tab: 'photos' }>

/* Who is backing up: the account, then three numbers read down their columns. */
const USERS_GRID =
  'grid grid-cols-[minmax(0,1fr)_4rem_4rem_4.5rem] items-center gap-x-3 px-5 @max-[18rem]/table:grid-cols-[minmax(0,1fr)_4.5rem_4.5rem]'
const HIDE_NARROW = '@max-[18rem]/table:hidden'

export function PhotosView({ data: d }: { data: Photos }) {
  const total = (d.photos ?? 0) + (d.videos ?? 0)
  const diskPct =
    d.disk.usedBytes === null || d.disk.freeBytes === null
      ? null
      : (d.disk.usedBytes / (d.disk.usedBytes + d.disk.freeBytes)) * 100

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
          <div className="flex items-center gap-6 max-[30rem]:flex-col max-[30rem]:items-start [&>dl]:flex-auto">
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
          <p className={CAPTION}>
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

        <Board title="Who is backing up" icon="◑" span={4}>
          {d.users.length === 0 ? (
            <p className={EMPTY}>could not read the user list</p>
          ) : (
            <ul className={BOARD_TABLE}>
              <li className={cn(USERS_GRID, BOARD_TABLE_HEAD)}>
                <span>Account</span>
                <span className={NUM_CELL}>Stills</span>
                <span className={cn(NUM_CELL, HIDE_NARROW)}>Videos</span>
                <span className={NUM_CELL}>Size</span>
              </li>
              {d.users.map((u) => (
                <li key={u.name} className={cn(USERS_GRID, BOARD_TABLE_ROW)}>
                  <span className={CELL_NAME}>{u.name}</span>
                  <span className={cn(CELL_QUIET, 'text-right')}>{num(u.photos)}</span>
                  <span className={cn(CELL_QUIET, 'text-right', HIDE_NARROW)}>{num(u.videos)}</span>
                  <span className={cn(NUM_CELL, 'text-[0.84rem] text-foreground')}>
                    {bytes(u.usageBytes)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className={CAPTION}>
            Quotas are unset on every account, so the only ceiling is the dataset below.
          </p>
        </Board>

        <Board
          title="Disk"
          icon="grid"
          span={4}
          aside={<span className={NOTE}>{pct(diskPct, 1)} used</span>}
        >
          <Progress pct={diskPct} tone="info" />
          <Measures
            items={[
              { k: 'Used', v: bytes(d.disk.usedBytes) },
              { k: 'Free', v: bytes(d.disk.freeBytes) },
            ]}
          />
          <p className={CAPTION}>
            The <span className={MONO}>/s2/immich</span> dataset, on the mirror.
          </p>
          <p className={FOOT}>
            Read from node_exporter. Immich&rsquo;s own storage endpoint needs a permission this API
            key does not carry, and the dataset underneath is the same disk. Hourly, daily and
            weekly snapshots; on the mirror, so a single drive failure costs nothing.
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
