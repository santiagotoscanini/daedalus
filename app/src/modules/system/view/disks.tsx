import { LogBoard } from '../../../components/logs'
import { DISK_MODEL } from '../../../components/part'
import {
  CELL_NAME,
  CELL_QUIET,
  CELL_SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import {
  CAPTION,
  EMPTY,
  FOOT,
  LIST,
  MONO,
  MONO_FACE,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  SUB,
} from '../../../components/tokens'
import { Board, BoardGrid, Chip, Facts } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, DASH, num, pct } from '../../../lib/format'
import type { SystemData } from '../data'
import { decodeSeagate, diskPhoto, ModelDecode, PHOTO_W } from './disk-model'
import { hours, SYSTEM_SNAPSHOT } from './shared'

/* ── Disks ────────────────────────────────────────────────────────────── */

type Disks = Extract<SystemData, { tab: 'disks' }>
type Disk = Disks['disks'][number]
type Io = Disks['io'][number]

// The drives as ONE table first, because the question this tab is for is a
// comparison across them — which is hottest, which is oldest, which has the
// counter that moved — and a column is how a comparison is read. Then a board
// per drive for what does not compare: its identity, the counters that would
// fail first, its self-test log. Healthy readings stay in quiet ink; colour
// is kept for the drive that differs.

const GRID = cn(
  'grid items-center gap-x-4 px-5',
  // The drive keeps 16rem: a device, its family, never an ellipsis.
  'grid-cols-[minmax(16rem,1fr)_4rem_3rem_4.5rem_3.5rem_4rem_4rem_5rem_5rem_3rem_3.5rem]',
  '@max-[64rem]/table:grid-cols-[minmax(12rem,1fr)_4rem_3rem_4.5rem_4rem_4rem_3.5rem]',
  '@max-[36rem]/table:grid-cols-[minmax(0,1fr)_3.5rem_5.5rem]',
)
/** Steps away below a laptop half-window, and below a phone. */
const WIDE = '@max-[64rem]/table:hidden'
const MID = '@max-[36rem]/table:hidden'
const N = 'text-right tabular-nums'

export function DisksView({ d }: { d: Disks }) {
  const io = new Map(d.io.map((i) => [i.device, i]))

  return (
    <div className="flex flex-col gap-10">
      <TableSection title="Drives" aside={`${String(d.disks.length)} in this box`}>
        <ul className={TABLE}>
          <li aria-hidden="true" className={cn(GRID, TABLE_HEAD)}>
            <span>Drive</span>
            <span className={cn(N, MID)}>Size</span>
            <span className={N}>Temp</span>
            <span className={cn(N, MID)}>Powered on</span>
            <span className={cn(N, WIDE)}>Cycles</span>
            <span className={cn(N, MID)} title="Reallocated sectors, on a spinning disk">
              Realloc.
            </span>
            <span className={cn(N, MID)} title="Rated endurance used, on an SSD">
              Wear %
            </span>
            <span className={cn(N, WIDE)}>Read</span>
            <span className={cn(N, WIDE)}>Written</span>
            <span className={cn(N, WIDE)}>Busy</span>
            <span className="text-right">SMART</span>
          </li>
          {d.disks.length === 0 && (
            <li className={TABLE_EMPTY}>
              No snapshot yet. The host reader has not run, or could not read SMART.
            </li>
          )}
          {d.disks.map((disk) => (
            <DiskRow key={disk.device} disk={disk} stats={io.get(disk.device)} />
          ))}
        </ul>
        <p className={FOOT}>
          Temperature, age and wear from each drive&rsquo;s own SMART log, read by the host every
          ten minutes. A spinning disk wears in reallocated sectors, an SSD in the share of its
          rated endurance used. Read, written and busy are node-exporter&rsquo;s 5-minute averages.
        </p>
      </TableSection>

      <BoardGrid>
        {d.disks.map((disk) => (
          <DiskBoard key={disk.device} disk={disk} />
        ))}

        <Board title="How these are tested" icon="✓" span={12}>
          <Facts
            rows={[
              { k: 'Short self-test', v: 'every Saturday, 02:00' },
              { k: 'Extended self-test', v: 'the 1st of each month, 03:00' },
              {
                k: 'smartd',
                v:
                  d.smartdActive === null ? (
                    DASH
                  ) : d.smartdActive ? (
                    <span className="text-muted-foreground">running</span>
                  ) : (
                    <Chip tone="bad">not running</Chip>
                  ),
              },
            ]}
          />
          <p className={FOOT}>
            Autodetected across every disk, with no per-drive configuration: the schedule is one
            string in <span className={MONO}>platform/smartd.nix</span>. A drive that reports
            pre-failure sends mail, wired in <span className={MONO}>platform/mail</span>. The
            results above are read back off each drive&rsquo;s own log rather than from that
            schedule, so a test that was configured and never ran shows as an absence here.
          </p>
        </Board>

        <LogBoard
          source={{ unit: 'smartd.service' }}
          title="smartd"
          neighbours={[SYSTEM_SNAPSHOT]}
          foot={
            <p className={FOOT}>
              The daemon that runs the tests above and watches every attribute between them. Quiet
              is correct; it speaks when an attribute crosses its threshold.
            </p>
          }
        />
      </BoardGrid>
    </div>
  )
}

/** One drive, read across: the row the comparison is made on. */
function DiskRow({ disk, stats }: { disk: Disk; stats: Io | undefined }) {
  const nvme = disk.percentageUsed !== null
  const kind = disk.family ?? (nvme ? 'solid state' : 'hard disk')
  // Wear that has started is the exception the column exists for.
  const worn = nvme ? (disk.percentageUsed ?? 0) >= 80 : (disk.reallocated ?? 0) > 0
  return (
    <li className={cn(GRID, TABLE_ROW)}>
      <span className="flex min-w-0 flex-col">
        <span className={cn(CELL_NAME, MONO_FACE)}>{disk.device}</span>
        {/* The family alone: the rpm is the detail board's, and two facts here
            truncated at a laptop width. */}
        <span className={CELL_SUB} title={disk.model ?? undefined}>
          {kind}
        </span>
      </span>
      <span className={cn(CELL_QUIET, N, MID)}>
        {disk.sizeBytes === null ? DASH : bytes(disk.sizeBytes)}
      </span>
      <span className={cn(N, 'text-[0.8125rem] text-foreground')}>
        {disk.temperature === null ? DASH : `${String(disk.temperature)}°`}
      </span>
      <span className={cn(CELL_QUIET, N, MID)}>{hours(disk.powerOnHours)}</span>
      <span className={cn(CELL_QUIET, N, WIDE)}>{num(disk.powerCycles)}</span>
      {/* Two measures, two columns, the unit in the head: a spinning disk
          counts reallocated sectors, an SSD its share of rated endurance. */}
      <span className={cn(N, MID, !nvme && worn ? 'text-warning' : CELL_QUIET)}>
        {nvme ? DASH : num(disk.reallocated)}
      </span>
      <span className={cn(N, MID, nvme && worn ? 'text-warning' : CELL_QUIET)}>
        {nvme ? (disk.percentageUsed === null ? DASH : num(disk.percentageUsed)) : DASH}
      </span>
      <span className={cn(CELL_QUIET, N, WIDE)}>
        {stats?.readBytes == null ? DASH : `${bytes(stats.readBytes)}/s`}
      </span>
      <span className={cn(CELL_QUIET, N, WIDE)}>
        {stats?.writtenBytes == null ? DASH : `${bytes(stats.writtenBytes)}/s`}
      </span>
      <span className={cn(CELL_QUIET, N, WIDE)}>{pct(stats?.utilPct ?? null, 1)}</span>
      <span className="flex justify-end">
        {disk.passed === null ? (
          <span className={CELL_QUIET}>no SMART</span>
        ) : disk.passed ? (
          <span className={CELL_QUIET}>ok</span>
        ) : (
          <Chip tone="bad">failing</Chip>
        )}
      </span>
    </li>
  )
}

/** One drive's detail: what it is, what would fail first, its last tests. */
function DiskBoard({ disk }: { disk: Disk }) {
  const nvme = disk.percentageUsed !== null
  const failedTest = disk.selfTests.find((t) => !t.passed)
  const photo = diskPhoto(disk.model)
  const decoded = decodeSeagate(disk.model)

  return (
    <Board
      title={disk.device}
      icon={nvme ? '⚡' : '▦'}
      /* A third each, so three drives are one row — the same order as the
         table above, so a reading there is found here by position. Boards
         stretch to a shared bottom edge, so the row is as tall as the drive
         with the most to say. */
      span={4}
      // The table says ok for every healthy drive; the board speaks only when
      // its drive is the exception.
      aside={disk.passed === false ? <Chip tone="bad">SMART failing</Chip> : undefined}
    >
      <div className="flex items-center gap-3.5 pb-1">
        {photo !== null && (
          <img
            className={cn('h-auto flex-none object-contain', PHOTO_W[photo.shape])}
            src={photo.src}
            alt=""
            width={photo.width}
            height={photo.height}
          />
        )}
        <div className="flex min-w-0 flex-col items-start gap-1">
          {decoded === null ? (
            <strong className={DISK_MODEL}>{disk.model ?? '?'}</strong>
          ) : (
            <ModelDecode model={disk.model ?? '?'} segments={decoded} />
          )}
          <span className="text-[0.72rem] text-subdued leading-[1.3]">
            {disk.family ?? (nvme ? 'solid state' : 'hard disk')}
            {disk.sizeBytes !== null && ` · ${bytes(disk.sizeBytes)}`}
            {disk.rotationRate !== null &&
              disk.rotationRate > 0 &&
              ` · ${num(disk.rotationRate)} rpm`}
          </span>
          {/* The one line here that is never read and always needed: it
              is what an RMA asks for, so it stays legible and out of the
              way. */}
          {disk.serial !== null && (
            <span className={cn(MONO_FACE, 'text-[0.72rem] text-muted-foreground')}>
              {disk.serial}
            </span>
          )}
        </div>
      </div>

      <h4 className={SUB}>What would fail first</h4>
      <Facts
        rows={
          nvme
            ? [
                { k: 'Spare blocks', v: pct(disk.spareAvailable) },
                { k: 'Media errors', v: num(disk.mediaErrors) },
                { k: 'Unsafe shutdowns', v: num(disk.unsafeShutdowns) },
                {
                  k: 'Critical warning',
                  v:
                    disk.criticalWarning === null ? (
                      DASH
                    ) : disk.criticalWarning === 0 ? (
                      'none'
                    ) : (
                      <Chip tone="bad">{num(disk.criticalWarning)}</Chip>
                    ),
                },
              ]
            : [
                { k: 'Reallocated sectors', v: num(disk.reallocated) },
                { k: 'Pending sectors', v: num(disk.pending) },
                { k: 'Offline uncorrectable', v: num(disk.uncorrectable) },
                {
                  k: 'Link CRC errors',
                  v:
                    disk.crcErrors === null ? (
                      DASH
                    ) : disk.crcErrors > 0 ? (
                      <span className="text-warning">{num(disk.crcErrors)}</span>
                    ) : (
                      num(disk.crcErrors)
                    ),
                },
              ]
        }
      />
      {!nvme && (disk.crcErrors ?? 0) > 0 && (
        // The distinction that decides what you'd actually do about it.
        <p className={CAPTION}>
          A link CRC error is the <em>cable</em>, not the platter: a transfer that had to be retried
          between the controller and the drive. It never decrements, so this is a lifetime count. A
          stable one is nothing. A climbing one means reseating a SATA cable.
        </p>
      )}

      <h4 className={SUB}>Self-tests</h4>
      <ul className={LIST}>
        {disk.selfTests.slice(0, 5).map((t, i) => (
          <li
            key={`${t.type ?? '?'}-${String(t.hours ?? i)}-${String(i)}`}
            className={cn(ROW, 'grid grid-cols-[minmax(0,1fr)_2.5rem_4rem] gap-x-3')}
          >
            {/* A pass is the norm and reads as a word in its own column; the
                test that did not finish carries its chip under its name, so a
                long status never squeezes the name to an ellipsis. */}
            <span className="flex min-w-0 flex-col items-start gap-1">
              <span className={cn(ROW_MAIN, t.type === null && 'text-muted-foreground')}>
                {t.type ?? 'unnamed test'}
              </span>
              {!t.passed && <Chip tone="warn">{t.status ?? 'failed'}</Chip>}
            </span>
            <span className={cn(ROW_SIDE, 'max-w-none text-right')}>{t.passed ? 'ok' : ''}</span>
            <span className={cn(ROW_SIDE, 'max-w-none text-right')}>
              {/* Against the drive's CURRENT hours, because the drive has
                  no calendar — it counts hours, not dates. */}
              {t.hours === null || disk.powerOnHours === null
                ? DASH
                : `${hours(disk.powerOnHours - t.hours)} ago`}
            </span>
          </li>
        ))}
        {disk.selfTests.length === 0 && <p className={EMPTY}>no tests on record</p>}
      </ul>

      {failedTest !== undefined && (
        <p className={CAPTION}>
          The most recent <b>{failedTest.type ?? 'test'}</b> did not finish:{' '}
          {failedTest.status ?? 'unknown'}. An interrupted test is not a failing disk; a host reset
          or a power event ends one. It does mean that scheduled check verified nothing.
        </p>
      )}
    </Board>
  )
}
