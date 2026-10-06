import { LogBoard } from '../../../components/logs'
import { DISK_MODEL } from '../../../components/part'
import {
  CAPTION,
  EMPTY,
  FOOT,
  LIST,
  MONO,
  MONO_FACE,
  NOTE,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  SUB,
} from '../../../components/tokens'
import { Board, BoardGrid, Chip, Facts, Measures } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { bytes, DASH, num, pct } from '../../../lib/format'
import type { SystemData } from '../data'
import { decodeSeagate, diskPhoto, ModelDecode, PHOTO_W } from './disk-model'
import { hours, SYSTEM_SNAPSHOT } from './shared'

/* ── Disks ────────────────────────────────────────────────────────────── */

type Disks = Extract<SystemData, { tab: 'disks' }>

export function DisksView({ d }: { d: Disks }) {
  const io = new Map(d.io.map((i) => [i.device, i]))

  return (
    <BoardGrid>
      {d.disks.length === 0 && (
        <Board title="Disks" icon="grid" span={12}>
          <p className={EMPTY}>
            No snapshot yet. The host reader has not run, or could not read SMART.
          </p>
        </Board>
      )}

      {d.disks.map((disk) => (
        <DiskBoard key={disk.device} disk={disk} stats={io.get(disk.device)} />
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
                  <Chip tone="ok">running</Chip>
                ) : (
                  <Chip tone="bad">not running</Chip>
                ),
            },
          ]}
        />
        <p className={FOOT}>
          Autodetected across every disk, with no per-drive configuration: the schedule is one
          string in <span className={MONO}>platform/smartd.nix</span>. A drive that reports
          pre-failure sends mail, wired in <span className={MONO}>platform/mail</span>. The results
          above are read back off each drive&rsquo;s own log rather than from that schedule, so a
          test that was configured and never ran shows as an absence here.
        </p>
      </Board>

      <LogBoard
        source={{ unit: 'smartd.service' }}
        title="smartd"
        neighbours={[SYSTEM_SNAPSHOT]}
        foot={
          <p className={FOOT}>
            The daemon that runs the tests above and watches every attribute between them. Quiet is
            correct; it speaks when an attribute crosses its threshold.
          </p>
        }
      />
    </BoardGrid>
  )
}

/** One drive: what it is, how worn, how it is doing, and its last tests. */
function DiskBoard({
  disk,
  stats,
}: {
  disk: Disks['disks'][number]
  stats: Disks['io'][number] | undefined
}) {
  const nvme = disk.percentageUsed !== null
  const failedTest = disk.selfTests.find((t) => !t.passed)
  const photo = diskPhoto(disk.model)
  const decoded = decodeSeagate(disk.model)

  return (
    <Board
      title={disk.device}
      icon={nvme ? '⚡' : '▦'}
      /* A third each, so three drives are one row and one reading — at a
         half, the third lands alone on a line beside empty grid and reads
         as a second subject, while the comparison this page is for is
         across all of them: which is hottest, which is oldest, which has
         the counter that moved. Boards stretch to a shared bottom edge,
         so the row is as tall as the drive with the most to say. */
      span={4}
      aside={
        disk.passed === null ? (
          <span className={NOTE}>no SMART</span>
        ) : disk.passed ? (
          <Chip tone="ok">SMART ok</Chip>
        ) : (
          <Chip tone="bad">SMART failing</Chip>
        )
      }
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

      <Measures
        items={[
          {
            k: 'temperature',
            v: disk.temperature === null ? DASH : `${String(disk.temperature)}°`,
          },
          { k: 'powered on', v: hours(disk.powerOnHours) },
          { k: 'power cycles', v: num(disk.powerCycles) },
          {
            k: nvme ? 'endurance used' : 'reallocated',
            v: nvme ? pct(disk.percentageUsed) : num(disk.reallocated),
          },
        ]}
      />

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
                      <Chip tone="ok">none</Chip>
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
        <p className={cn(CAPTION, 'text-warning')}>
          A link CRC error is the <em>cable</em>, not the platter: a transfer that had to be retried
          between the controller and the drive. It never decrements, so this is a lifetime count. A
          stable one is nothing. A climbing one means reseating a SATA cable.
        </p>
      )}

      <h4 className={SUB}>Self-tests</h4>
      <ul className={LIST}>
        {disk.selfTests.slice(0, 5).map((t, i) => (
          <li key={`${t.type ?? '?'}-${String(t.hours ?? i)}-${String(i)}`} className={ROW}>
            <span className={ROW_MAIN}>{t.type ?? '?'}</span>
            <span className={ROW_SIDE}>
              {t.passed ? (
                <Chip tone="ok">ok</Chip>
              ) : (
                <Chip tone="warn">{t.status ?? 'failed'}</Chip>
              )}
            </span>
            <span className={ROW_SIDE}>
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

      {stats !== undefined && (
        <>
          <h4 className={SUB}>Throughput, 5-minute average</h4>
          <Measures
            items={[
              { k: 'read', v: `${bytes(stats.readBytes)}/s` },
              { k: 'written', v: `${bytes(stats.writtenBytes)}/s` },
              { k: 'busy', v: pct(stats.utilPct, 1) },
            ]}
          />
        </>
      )}

      {failedTest !== undefined && (
        <p className={cn(CAPTION, 'text-warning')}>
          The most recent <b>{failedTest.type ?? 'test'}</b> did not finish:{' '}
          {failedTest.status ?? 'unknown'}. An interrupted test is not a failing disk; a host reset
          or a power event ends one. It does mean that scheduled check verified nothing.
        </p>
      )}
    </Board>
  )
}
