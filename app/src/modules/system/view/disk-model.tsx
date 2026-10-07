// What a drive's model string says: its photograph, and Seagate's model
// number decoded segment by segment.

import { InfoHint } from '../../../components/hint'
import { DISK_MODEL } from '../../../components/part'
import { cn } from '../../../lib/cn'

/**
 * The drive in the picture, matched on the model string SMART reports.
 *
 * Same argument as the router's photograph on Network: these panels are about
 * physical objects in the house, and a 3.5" platter drive and an M.2 stick are
 * not interchangeable in any way that matters when you are about to open the
 * case. Nothing infers a photo from `rotationRate` — a stock image of "a hard
 * disk" would be decoration, and a wrong one would be worse than none, so an
 * unrecognised model gets no picture and the panel reads without one.
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

export function diskPhoto(model: string | null): DiskPhoto | null {
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
export const PHOTO_W: Record<DiskPhoto['shape'], string> = {
  platter: 'w-[clamp(52px,18%,78px)]',
  stick: 'w-[clamp(104px,33%,150px)]',
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

/** Alternating weight, not five hues, and no accent — spelled per key because
    an interpolated class name is a class Tailwind never sees. */
const SEG_INK: Record<Segment['key'], string> = {
  maker: 'text-foreground',
  capacity: 'text-foreground',
  class: 'text-foreground',
  variant: 'text-foreground',
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
 * a `Board` is `overflow-hidden` and anything escaping it would be clipped
 * rather than shown. It overlays the panel below it, which is what a tooltip
 * does anyway, and it needs no positioning library to do it.
 *
 * The rows are spans, not a <ul>: InfoHint's trigger is a <button>, whose
 * content model has no room for list elements.
 */
export function ModelDecode({ model, segments }: { model: string; segments: Segment[] }) {
  return (
    <InfoHint
      className="inline-block max-w-full focus-visible:rounded-[4px] focus-visible:outline-1 focus-visible:outline-offset-[3px] focus-visible:outline-primary-dim"
      cardClassName="top-[calc(100%+0.45rem)] left-0 w-[max(240px,100%)] max-w-[92cqw]"
      label={`${model}, decoded`}
      trigger={
        // The dotted underline is the whole affordance: a disclosure nobody
        // can see is a disclosure nobody opens, and there is no room on this
        // board for a button.
        <strong className={cn(DISK_MODEL, 'inline border-muted-foreground border-b border-dotted')}>
          {segments.map((s, i) => (
            <span key={`${s.text}-${String(i)}`} className={SEG_INK[s.key]}>
              {s.text}
            </span>
          ))}
        </strong>
      }
    >
      <span className="mb-2 block font-mono text-[0.72rem] text-muted-foreground">{model}</span>
      <span className="flex flex-col gap-2">
        {segments.map((s, i) => (
          // The code, its name, then what it means — the code column sized to
          // the widest so the names line up and the list reads as a key.
          <span
            key={`${s.text}-${String(i)}`}
            className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-[0.05rem]"
          >
            <code className={cn('font-mono text-[0.75rem]', SEG_INK[s.key])}>{s.text}</code>
            <span className="text-[0.75rem] text-foreground">{s.label}</span>
            <span className="col-start-2 text-[0.72rem] text-muted-foreground leading-[1.4]">
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
export function decodeSeagate(model: string | null): Segment[] | null {
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

/** "Interrupted (host reset)" → "interrupted": the chip says what happened, the hover why. */
export function shortStatus(s: string | null): string {
  if (s === null) return 'failed'
  const open = s.indexOf('(')
  return (open > 0 ? s.slice(0, open) : s).trim().toLowerCase()
}
