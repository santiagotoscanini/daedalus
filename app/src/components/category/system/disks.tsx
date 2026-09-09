import { cn } from '../../../lib/cn'
import type { SystemData } from '../../../lib/dashboard/categories/system'
import { bytes, DASH, num, pct } from '../../../lib/format'
import { InfoHint } from '../../hint'
import { LogBoard } from '../../logs'
import { Board, BoardGrid, Chip, Facts, Measures } from '../../viz'
import {
  BOARD_FOOT,
  BOARD_NOTE,
  BOARD_SUB,
  hours,
  LIST,
  MONO,
  MONO_FACE,
  ROW,
  ROW_MAIN,
  ROW_SIDE,
  SYSTEM_SNAPSHOT,
  VIZ_EMPTY,
} from './shared'

/* ── Disks ────────────────────────────────────────────────────────────── */

type Disks = Extract<SystemData, { tab: 'disks' }>

/**
 * The drive in the picture, matched on the model string SMART reports.
 *
 * Same argument as the router's photograph on Network: these panels are about
 * physical objects in the house, and a 3.5" platter drive and an M.2 stick are
 * not interchangeable in any way that matters when you are about to open the
 * case. Nothing infers a photo from `rotationRate` — a stock image of "a hard
 * disk" would be decoration, and a wrong one would be worse than none, so an
 * unrecognised model gets no picture and the panel reads exactly as before.
 *
 * The intrinsic dimensions are the files' own, so the aspect ratio is reserved
 * before the image loads and nothing below it jumps.
 */
type DiskPhoto = { src: string; width: number; height: number; shape: 'platter' | 'stick' }

const DISK_PHOTOS: readonly { model: string; photo: DiskPhoto }[] = [
  {
    model: 'ST16000NE000',
    photo: { src: '/disk-ironwolf-pro.png', width: 480, height: 696, shape: 'platter' },
  },
  {
    model: 'Samsung SSD 990 PRO',
    photo: { src: '/disk-990-pro.webp', width: 700, height: 346, shape: 'stick' },
  },
]

function diskPhoto(model: string | null): DiskPhoto | null {
  if (model === null) return null
  return DISK_PHOTOS.find((d) => model.includes(d.model))?.photo ?? null
}

/**
 * Two shapes, two sizes, because a 3.5" drive and an M.2 stick share no
 * dimension.
 *
 * Sized to land in the same height band rather than to a common width — at
 * equal width the stick dwarfs the drive it is a fraction of, and at true
 * relative scale it would be a smudge. The platter stays the taller of the
 * two, which is the one honest thing about their proportions.
 *
 * Both are a fraction of the board rather than a fixed size, and the fraction
 * is small because the board is a third of the page: the model string beside
 * it is the longest line in the panel, and a picture that took half the width
 * would wrap "Samsung SSD 990 PRO with Heatsink 4TB" over four lines to say
 * something the reader can already see. The maximum caps it on the phone,
 * where every board is full width and a percentage would run away.
 */
const PHOTO_W: Record<DiskPhoto['shape'], string> = {
  platter: 'w-[clamp(52px,18%,78px)]',
  stick: 'w-[clamp(104px,33%,150px)]',
}

/** What SMART calls the drive — the string you would type into a shop. */
const DISK_MODEL = 'text-[0.94rem] text-foreground tracking-[-0.01em] wrap-anywhere'

/**
 * What Seagate's class code says the drive is.
 *
 * The two letters after the capacity are the only part of the part number
 * that changes what the drive IS, and the difference that matters here is
 * the workload rate limit: NE and NT are both "IronWolf Pro" on the label
 * and on the box, and they are rated 300 and 500 TB/year respectively. That
 * is the number to check a part number against before buying a replacement,
 * and it is nowhere on this page otherwise.
 */
const SEAGATE_CLASSES: Record<string, { line: string; note: string }> = {
  NE: { line: 'IronWolf Pro', note: 'NAS, rated 300 TB/year of reads and writes' },
  NT: {
    line: 'IronWolf Pro',
    note: 'NAS, rated 500 TB/year. Same label as NE, higher limit.',
  },
  VN: { line: 'IronWolf', note: 'NAS, rated 180 TB/year' },
  NM: { line: 'Exos', note: 'enterprise, rated 550 TB/year' },
  VX: { line: 'SkyHawk', note: 'surveillance, tuned for many sequential write streams' },
  DM: { line: 'BarraCuda', note: 'desktop, with no vibration handling and no workload rating' },
}

/**
 * `key` drives the colour, and the colours are not decorative.
 *
 * Everywhere else on this dashboard a colour means a fault, so five rotating
 * hues over a part number would spend the one signal the palette has on
 * something that is never wrong. Instead the segments alternate between plain
 * and dimmed so their boundaries read, and exactly one — the class code —
 * takes the accent, because it is the only segment whose value changes what
 * you would buy.
 */
type Segment = {
  key: 'maker' | 'capacity' | 'class' | 'variant' | 'config'
  text: string
  label: string
  note: string
}

/** Alternating weight, not five hues, and one accent — spelled per key because
    an interpolated class name is a class Tailwind never sees. */
const SEG_INK: Record<Segment['key'], string> = {
  maker: 'text-(--text-muted)',
  capacity: 'text-foreground',
  class: 'text-primary',
  variant: 'text-(--text-muted)',
  config: 'text-foreground',
}

/**
 * A part number that explains itself on hover.
 *
 * The string is the drive's identity and it is unreadable — `ST16000NE000` is
 * five separate facts run together, and the one that decides whether a
 * replacement is the same drive (the workload rating) is two letters in the
 * middle. Colouring the segments makes it legible at a glance; the card makes
 * it readable.
 *
 * Positioned inside the board rather than floating above the page, because
 * `.board` is `overflow: hidden` and anything escaping it would be clipped
 * rather than shown. It overlays the panel below it, which is what a tooltip
 * does anyway, and it needs no positioning library to do it.
 *
 * The rows are spans, not a <ul>: InfoHint's trigger is a <button>, whose
 * content model has no room for list elements.
 */
function ModelDecode({ model, segments }: { model: string; segments: Segment[] }) {
  return (
    <InfoHint
      className="inline-block max-w-full focus-visible:rounded-[4px] focus-visible:outline-1 focus-visible:outline-offset-[3px] focus-visible:outline-(color:--brand-dim)"
      cardClassName="top-[calc(100%+0.45rem)] left-0 w-[max(240px,100%)] max-w-[92cqw]"
      label={`${model}, decoded`}
      trigger={
        // The dotted underline is the whole affordance: a disclosure nobody
        // can see is a disclosure nobody opens, and there is no room on this
        // board for a button.
        <strong className={cn(DISK_MODEL, 'inline border-(--dim) border-b border-dotted')}>
          {segments.map((s, i) => (
            <span key={`${s.text}-${String(i)}`} className={SEG_INK[s.key]}>
              {s.text}
            </span>
          ))}
        </strong>
      }
    >
      <span className="mb-[0.4rem] block font-mono text-[0.68rem] text-muted-foreground tracking-[0.04em]">
        {model}
      </span>
      <span className="flex flex-col gap-[0.45rem]">
        {segments.map((s, i) => (
          // The code, its name, then what it means — the code column sized to
          // the widest so the names line up and the list reads as a key.
          <span
            key={`${s.text}-${String(i)}`}
            className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-[0.05rem]"
          >
            <code className={cn('font-mono text-[0.74rem]', SEG_INK[s.key])}>{s.text}</code>
            <span className="text-[0.74rem] text-foreground">{s.label}</span>
            <span className="col-start-2 text-[0.7rem] text-muted-foreground leading-[1.4]">
              {s.note}
            </span>
          </span>
        ))}
      </span>
    </InfoHint>
  )
}

/**
 * Split a Seagate part number into the things it is actually saying.
 *
 * Derived from the string rather than declared per drive, so a replacement
 * with a different suffix — or a different line entirely — decodes on its own
 * instead of silently showing the old drive's explanation. Anything that is
 * not a Seagate part number returns null and the panel simply does not offer
 * the reading; a decode that guesses is worse than no decode, because the
 * whole point of this is checking a number before spending money on it.
 */
function decodeSeagate(model: string | null): Segment[] | null {
  if (model === null) return null
  const m = /^ST(\d+)([A-Z]{2})(\d+)(?:-(.+))?$/.exec(model)
  if (m === null) return null

  const [, gb, code, variant, suffix] = m
  const cls = SEAGATE_CLASSES[code ?? '']
  const tb = Number(gb) / 1000

  const segments: Segment[] = [
    {
      key: 'maker',
      text: 'ST',
      label: 'Seagate',
      note: 'The maker. Every Seagate part number opens with it.',
    },
    {
      key: 'capacity',
      text: gb ?? '',
      label: `${tb % 1 === 0 ? tb.toFixed(0) : tb.toFixed(1)} TB`,
      note: 'Capacity in gigabytes, decimal, which is why the operating system reports less.',
    },
    {
      key: 'class',
      text: code ?? '',
      label: cls?.line ?? 'unknown line',
      note:
        cls?.note ??
        'Seagate’s class code. This one is not in the table on this page, so the line is a guess and is not being made.',
    },
    {
      key: 'variant',
      text: variant ?? '',
      label: 'variant',
      note: 'The generation within that line: platter count, cache and internal design. Two drives differing only here are the same product bought a year apart.',
    },
  ]
  if (suffix !== undefined) {
    segments.push({
      key: 'config',
      text: `-${suffix}`,
      label: 'configuration',
      note: 'Seagate’s internal suffix: firmware, region and how it was packaged. A retail box and a bare OEM drive of the same model differ here and nowhere else.',
    })
  }
  return segments
}

export function DisksView({ d }: { d: Disks }) {
  const io = new Map(d.io.map((i) => [i.device, i]))

  return (
    <BoardGrid>
      {d.disks.length === 0 && (
        <Board title="Disks" icon="grid" span={12}>
          <p className={VIZ_EMPTY}>
            No snapshot yet. The host reader has not run, or could not read SMART.
          </p>
        </Board>
      )}

      {d.disks.map((disk) => {
        const nvme = disk.percentageUsed !== null
        const stats = io.get(disk.device)
        const failedTest = disk.selfTests.find((t) => !t.passed)
        const photo = diskPhoto(disk.model)
        const decoded = decodeSeagate(disk.model)

        return (
          <Board
            key={disk.device}
            title={disk.device}
            icon={nvme ? '⚡' : '▦'}
            /* A third each, so the machine's three drives are one row and one
               reading. At a half they were a pair and an orphan, which put the
               NVMe on a line of its own beside empty grid and read as a second
               subject — and the comparison this page is for is across all
               three: which is hottest, which is oldest, which has the counter
               that moved. Boards stretch to a shared bottom edge, so the row
               is as tall as the drive with the most to say. */
            span={4}
            aside={
              disk.passed === null ? (
                <span className={BOARD_NOTE}>no SMART</span>
              ) : disk.passed ? (
                <Chip tone="ok">SMART ok</Chip>
              ) : (
                <Chip tone="bad">SMART failing</Chip>
              )
            }
          >
            <div className="flex items-center gap-[0.9rem] pb-2">
              {photo !== null && (
                <img
                  className={cn('h-auto flex-none object-contain', PHOTO_W[photo.shape])}
                  src={photo.src}
                  alt=""
                  width={photo.width}
                  height={photo.height}
                />
              )}
              <div className="flex min-w-0 flex-col items-start gap-[0.22rem]">
                {decoded === null ? (
                  <strong className={DISK_MODEL}>{disk.model ?? '?'}</strong>
                ) : (
                  <ModelDecode model={disk.model ?? '?'} segments={decoded} />
                )}
                <span className="text-[0.72rem] text-(--text-muted) leading-[1.3]">
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
                  <span className={cn(MONO_FACE, 'text-[0.7rem] text-muted-foreground')}>
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

            <h4 className={BOARD_SUB}>What would fail first</h4>
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
              <p className={cn(BOARD_FOOT, 'text-warning')}>
                A link CRC error is the <em>cable</em>, not the platter: a transfer that had to be
                retried between the controller and the drive. It never decrements, so this is a
                lifetime count. A stable one is nothing. A climbing one means reseating a SATA
                cable.
              </p>
            )}

            <h4 className={BOARD_SUB}>Self-tests</h4>
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
              {disk.selfTests.length === 0 && <p className={VIZ_EMPTY}>no tests on record</p>}
            </ul>

            {stats !== undefined && (
              <>
                <h4 className={BOARD_SUB}>Throughput, 5-minute average</h4>
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
              <p className={cn(BOARD_FOOT, 'text-warning')}>
                The most recent <b>{failedTest.type ?? 'test'}</b> did not finish:{' '}
                {failedTest.status ?? 'unknown'}. An interrupted test is not a failing disk; a host
                reset or a power event ends one. It does mean that scheduled check verified nothing.
              </p>
            )}
          </Board>
        )
      })}

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
        <p className={BOARD_FOOT}>
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
          <p className={BOARD_FOOT}>
            The daemon that runs the tests above and watches every attribute between them. Quiet is
            correct; it speaks when an attribute crosses its threshold.
          </p>
        }
      />
    </BoardGrid>
  )
}
