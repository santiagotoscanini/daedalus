import type { Tone } from '../../../components/viz'
import { Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import type { NetworkData } from '../data'
import { FOOT, GROUP, MAIN, MONO, ROW, ROWS, SIDE } from './shared'

// Network › DNS: the folded list of raw zone records, and the spacing rule
// every fold on the tab shares.

type Dns = Extract<NetworkData, { tab: 'dns' }>

/* Consecutive folds get air between them, and only consecutive ones: a fold
   that follows a table of facts already has the board body's own gap. The
   marker attribute is what makes "the one before me is a fold" expressible. */
export const FOLD_STACK = '[[data-fold]+&]:mt-[0.5rem]'

/**
 * A folded group of raw records.
 *
 * Collapsed by default and never rendered at all when empty: an open box
 * saying "0 leftovers" is a claim worth making once, in the board's aside,
 * rather than a section of the page.
 */
export function RecordList({
  records,
  summary,
  note,
  tone = 'muted',
  open = false,
}: {
  records: Dns['zone']['elsewhere']
  summary: string
  note: string
  tone?: Tone
  open?: boolean
}) {
  if (records.length === 0) return null

  /* A record's own fields are not unique: Leftovers holds exact duplicates by
     definition, and a ZoneRecord carries no Cloudflare id to tell them apart.
     So each key is the fields plus which copy of them this row is — stable
     when other records come and go, unlike a bare row index. */
  const copies = new Map<string, number>()
  const rowKeys = records.map((r) => {
    const base = `${r.fqdn}-${r.type}-${r.content}`
    const n = copies.get(base) ?? 0
    copies.set(base, n + 1)
    return `${base}-${n}`
  })

  return (
    <details data-fold className={cn(GROUP, FOLD_STACK)} open={open}>
      <summary>
        {summary}
        <Chip tone={tone}>{records.length}</Chip>
      </summary>
      {/* Grid tracks, not flex — a per-row flex layout put each type chip at a
          different x, so a column of CNAMEs read as scattered rather than as a
          column. `min-w-0` on the giving track is what lets its ellipsis fire
          at all: a grid item's default `auto` minimum refuses to shrink below
          its content, so without it the row overflows instead of truncating. */}
      <ul className={ROWS}>
        {records.map((r, i) => (
          <li
            key={rowKeys[i]}
            className={cn(ROW, 'grid grid-cols-[minmax(6rem,16rem)_3.4rem_1fr] gap-[0.4rem]')}
          >
            <span className={cn(MAIN, MONO)}>{r.short}</span>
            <Chip tone="muted">{r.type}</Chip>
            {/* Content is the widest thing in the row and the least important —
                a DKIM key is 200 characters of base64 nobody reads on a
                dashboard. */}
            <span className={cn(MONO, SIDE, 'max-w-none flex-auto text-left opacity-85')}>
              {r.content}
            </span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>{note}</p>
    </details>
  )
}
