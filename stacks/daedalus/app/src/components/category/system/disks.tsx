import type { SystemData } from '../../../lib/dashboard/categories/system'
import { bytes, DASH, num, pct } from '../../../lib/format'
import { InfoHint } from '../../hint'
import { LogBoard } from '../../logs'
import { Board, BoardGrid, Chip, Facts, Measures } from '../../viz'
import { hours, SYSTEM_SNAPSHOT } from './shared'

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
      className="decode"
      cardClassName="decode-card"
      label={`${model}, decoded`}
      trigger={
        <strong className="disk-model decode-string">
          {segments.map((s, i) => (
            <span key={`${s.text}-${String(i)}`} className={`decode-seg decode-seg-${s.key}`}>
              {s.text}
            </span>
          ))}
        </strong>
      }
    >
      <span className="decode-head">{model}</span>
      <span className="decode-list">
        {segments.map((s, i) => (
          <span key={`${s.text}-${String(i)}`} className="decode-item">
            <code className={`decode-seg decode-seg-${s.key}`}>{s.text}</code>
            <span className="decode-label">{s.label}</span>
            <span className="decode-note">{s.note}</span>
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
          <p className="viz-empty">
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
                <span className="board-note">no SMART</span>
              ) : disk.passed ? (
                <Chip tone="ok">SMART ok</Chip>
              ) : (
                <Chip tone="bad">SMART failing</Chip>
              )
            }
          >
            <div className="disk">
              {photo !== null && (
                <img
                  className={`disk-photo disk-photo-${photo.shape}`}
                  src={photo.src}
                  alt=""
                  width={photo.width}
                  height={photo.height}
                />
              )}
              <div className="disk-id">
                {decoded === null ? (
                  <strong className="disk-model">{disk.model ?? '?'}</strong>
                ) : (
                  <ModelDecode model={disk.model ?? '?'} segments={decoded} />
                )}
                <span className="disk-product">
                  {disk.family ?? (nvme ? 'solid state' : 'hard disk')}
                  {disk.sizeBytes !== null && ` · ${bytes(disk.sizeBytes)}`}
                  {disk.rotationRate !== null &&
                    disk.rotationRate > 0 &&
                    ` · ${num(disk.rotationRate)} rpm`}
                </span>
                {disk.serial !== null && <span className="disk-serial mono">{disk.serial}</span>}
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

            <h4 className="board-sub">What would fail first</h4>
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
                            <span className="text-warn">{num(disk.crcErrors)}</span>
                          ) : (
                            num(disk.crcErrors)
                          ),
                      },
                    ]
              }
            />
            {!nvme && (disk.crcErrors ?? 0) > 0 && (
              // The distinction that decides what you'd actually do about it.
              <p className="board-foot text-warn">
                A link CRC error is the <em>cable</em>, not the platter: a transfer that had to be
                retried between the controller and the drive. It never decrements, so this is a
                lifetime count. A stable one is nothing. A climbing one means reseating a SATA
                cable.
              </p>
            )}

            <h4 className="board-sub">Self-tests</h4>
            <ul className="itemlist">
              {disk.selfTests.slice(0, 5).map((t, i) => (
                <li key={`${t.type ?? '?'}-${String(t.hours ?? i)}-${String(i)}`}>
                  <span className="item-main">{t.type ?? '?'}</span>
                  <span className="item-side">
                    {t.passed ? (
                      <Chip tone="ok">ok</Chip>
                    ) : (
                      <Chip tone="warn">{t.status ?? 'failed'}</Chip>
                    )}
                  </span>
                  <span className="item-side">
                    {/* Against the drive's CURRENT hours, because the drive has
                        no calendar — it counts hours, not dates. */}
                    {t.hours === null || disk.powerOnHours === null
                      ? DASH
                      : `${hours(disk.powerOnHours - t.hours)} ago`}
                  </span>
                </li>
              ))}
              {disk.selfTests.length === 0 && <p className="viz-empty">no tests on record</p>}
            </ul>

            {stats !== undefined && (
              <>
                <h4 className="board-sub">Throughput, 5-minute average</h4>
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
              <p className="board-foot text-warn">
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
        <p className="board-foot">
          Autodetected across every disk, with no per-drive configuration: the schedule is one
          string in <span className="mono">platform/smartd.nix</span>. A drive that reports
          pre-failure sends mail, wired in <span className="mono">platform/mail</span>. The results
          above are read back off each drive&rsquo;s own log rather than from that schedule, so a
          test that was configured and never ran shows as an absence here.
        </p>
      </Board>

      <LogBoard
        source={{ unit: 'smartd.service' }}
        title="smartd"
        neighbours={[SYSTEM_SNAPSHOT]}
        foot={
          <p className="board-foot">
            The daemon that runs the tests above and watches every attribute between them. Quiet is
            correct; it speaks when an attribute crosses its threshold.
          </p>
        }
      />
    </BoardGrid>
  )
}
