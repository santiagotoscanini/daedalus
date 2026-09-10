// A line diff, for showing what an Apply will write.
//
// The site document is forty-odd lines and an edit changes one or two of
// them, so the preview wants the whole file with the changed lines marked —
// not hunks, not a word diff. A longest-common-subsequence walk over lines is
// exact for that, and at these sizes the quadratic table is a few thousand
// cells. No dependency: this is the entire algorithm.

export type DiffLine = { kind: 'same' | 'add' | 'del'; text: string }

/** Lines of a text, without the empty string a trailing newline would leave. */
function lines(text: string): string[] {
  if (text === '') return []
  const parts = text.split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

/**
 * `before` → `after`, line by line. Unchanged lines are kept, so the reader
 * sees a change in its place in the file; the order is the order of `after`
 * with deletions where they were in `before`.
 */
export function diffLines(before: string, after: string): DiffLine[] {
  const a = lines(before)
  const b = lines(after)
  const n = a.length
  const m = b.length
  // lcs[i][j] = length of the LCS of a[i..] and b[j..]; one flat array.
  const width = m + 1
  const lcs = new Uint32Array((n + 1) * width)
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lcs[i * width + j] =
        a[i] === b[j]
          ? (lcs[(i + 1) * width + j + 1] as number) + 1
          : Math.max(lcs[(i + 1) * width + j] as number, lcs[i * width + j + 1] as number)
    }
  }

  const out: DiffLine[] = []
  let i = 0
  let j = 0
  while (i < n && j < m) {
    const x = a[i] as string
    const y = b[j] as string
    if (x === y) {
      out.push({ kind: 'same', text: x })
      i++
      j++
    } else if ((lcs[(i + 1) * width + j] as number) >= (lcs[i * width + j + 1] as number)) {
      out.push({ kind: 'del', text: x })
      i++
    } else {
      out.push({ kind: 'add', text: y })
      j++
    }
  }
  for (; i < n; i++) out.push({ kind: 'del', text: a[i] as string })
  for (; j < m; j++) out.push({ kind: 'add', text: b[j] as string })
  return out
}

export type FoldedLine = DiffLine | { kind: 'fold'; count: number }

/**
 * The diff with long unchanged runs collapsed to `context` lines either side
 * of a change, the way a hunk view does. A one-line edit to a forty-line
 * file otherwise puts the change below the fold of any box that shows it;
 * the reader should see what moved without scrolling past what did not.
 * Runs shorter than a fold marker is worth (2·context + 1) are kept whole.
 */
export function foldUnchanged(diff: readonly DiffLine[], context = 3): FoldedLine[] {
  const out: FoldedLine[] = []
  let i = 0
  while (i < diff.length) {
    const line = diff[i] as DiffLine
    if (line.kind !== 'same') {
      out.push(line)
      i++
      continue
    }
    let j = i
    while (j < diff.length && (diff[j] as DiffLine).kind === 'same') j++
    const run = diff.slice(i, j)
    // Context is owed only towards a change: none before the first change at
    // the top of the file, none after the last one at the bottom.
    const lead = i === 0 ? 0 : context
    const trail = j === diff.length ? 0 : context
    if (run.length <= lead + trail + 1) {
      out.push(...run)
    } else {
      out.push(...run.slice(0, lead))
      out.push({ kind: 'fold', count: run.length - lead - trail })
      out.push(...run.slice(run.length - trail))
    }
    i = j
  }
  return out
}

/** How many lines an edit touches, for the summary line. */
export function diffCounts(diff: readonly DiffLine[]): { added: number; removed: number } {
  let added = 0
  let removed = 0
  for (const l of diff) {
    if (l.kind === 'add') added++
    else if (l.kind === 'del') removed++
  }
  return { added, removed }
}
