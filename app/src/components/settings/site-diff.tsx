import type { SiteEdit } from '../../core/site'
import { cn } from '../../lib/cn'
import {
  type DiffLine,
  diffCounts,
  diffLines,
  type FoldedLine,
  foldUnchanged,
} from '../../lib/text-diff'
import { Mono } from './shared'

const SUMMARY = cn(
  'flex min-w-0 cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2',
  'text-[0.84rem] hover:bg-lifted [&::-webkit-details-marker]:hidden',
  "before:text-[0.7rem] before:text-muted-foreground before:transition-transform before:duration-[0.12s] before:content-['▸']",
  'group-open:before:rotate-90',
)

/** Stable keys for a diff's lines: a line's text and kind, disambiguated by
    how many identical ones came before it. */
function keyed(diff: readonly FoldedLine[]): { key: string; line: FoldedLine }[] {
  const seen = new Map<string, number>()
  return diff.map((line) => {
    const base = line.kind === 'fold' ? `fold:${String(line.count)}` : `${line.kind}:${line.text}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { key: `${base}#${String(n)}`, line }
  })
}

const SIGN: Record<DiffLine['kind'], string> = { same: ' ', add: '+', del: '−' }

/**
 * What an Apply would write to site.json, as a line diff against the file as
 * committed. Collapsed by default: the changed FIELDS are in the summary and
 * on the Apply bar; the bytes are for the reader who wants to see exactly
 * what the commit will contain. Unchanged runs are folded to three lines of
 * context so the change is in view when the box opens, not below it.
 */
export function SiteDiff({ edit }: { edit: SiteEdit }) {
  if (edit.changes.length === 0) return null
  const full = diffLines(edit.render.before ?? '', edit.render.after)
  const { added, removed } = diffCounts(full)
  const diff = foldUnchanged(full, 3)
  return (
    <details className="group overflow-hidden rounded-[9px] border border-subtle bg-card">
      <summary className={SUMMARY}>
        <span className="[font-weight:550]">Show what will be written</span>
        <span className="text-[0.76rem] text-muted-foreground">
          <Mono className="text-[0.74rem]">site/site.json</Mono> · {edit.changes.join(', ')} ·{' '}
          <span className="text-success">+{added}</span>{' '}
          <span className="text-danger">−{removed}</span>
        </span>
        <span className="ml-auto text-[0.74rem] text-muted-foreground">
          Nothing on the box changes until Apply rebuilds from it.
        </span>
      </summary>
      <pre className="m-0 max-h-80 overflow-auto border-t border-subtle bg-raised px-3 py-2 font-mono text-[0.74rem] leading-[1.5]">
        {keyed(diff).map(({ key, line }) =>
          line.kind === 'fold' ? (
            <div key={key} className="-mx-1 flex gap-2 px-1 text-muted-foreground italic">
              <span className="w-3 flex-none select-none">⋯</span>
              <span>
                {line.count} unchanged line{line.count === 1 ? '' : 's'}
              </span>
            </div>
          ) : (
            <div
              key={key}
              className={cn(
                '-mx-1 flex gap-2 rounded-[3px] px-1',
                line.kind === 'del' && 'bg-danger/10 text-danger',
                line.kind === 'add' && 'bg-success/10 text-success',
              )}
            >
              <span className="w-3 flex-none select-none text-muted-foreground">
                {SIGN[line.kind]}
              </span>
              <span className="whitespace-pre">{line.text}</span>
            </div>
          ),
        )}
      </pre>
    </details>
  )
}
