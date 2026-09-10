import { describe, expect, it } from 'vitest'
import { diffCounts, diffLines, foldUnchanged } from './text-diff'

const same = (text: string) => ({ kind: 'same' as const, text })
const add = (text: string) => ({ kind: 'add' as const, text })
const del = (text: string) => ({ kind: 'del' as const, text })

describe('diffLines', () => {
  it('reports an identical text as all unchanged', () => {
    expect(diffLines('a\nb\nc\n', 'a\nb\nc\n')).toEqual([same('a'), same('b'), same('c')])
  })

  it('does not count a trailing newline as an empty last line', () => {
    expect(diffLines('a\n', 'a')).toEqual([same('a')])
    expect(diffLines('', '')).toEqual([])
  })

  it('marks a changed line as a removal followed by an addition, in place', () => {
    expect(
      diffLines('{\n  "lanIp": "192.168.0.2",\n}\n', '{\n  "lanIp": "192.168.0.9",\n}\n'),
    ).toEqual([
      same('{'),
      del('  "lanIp": "192.168.0.2",'),
      add('  "lanIp": "192.168.0.9",'),
      same('}'),
    ])
  })

  it('marks inserted and deleted lines without disturbing their neighbours', () => {
    expect(diffLines('a\nb\nc\n', 'a\nb\nx\nc\n')).toEqual([
      same('a'),
      same('b'),
      add('x'),
      same('c'),
    ])
    expect(diffLines('a\nb\nc\n', 'a\nc\n')).toEqual([same('a'), del('b'), same('c')])
  })

  it('renders the first write as all additions', () => {
    expect(diffLines('', 'a\nb\n')).toEqual([add('a'), add('b')])
  })

  it('keeps the changed lines of a list edit inside the list', () => {
    const before = '[\n  "8.8.8.8",\n  "8.8.4.4"\n]\n'
    const after = '[\n  "8.8.8.8",\n  "1.1.1.1",\n  "8.8.4.4"\n]\n'
    expect(diffLines(before, after)).toEqual([
      same('['),
      same('  "8.8.8.8",'),
      add('  "1.1.1.1",'),
      same('  "8.8.4.4"'),
      same(']'),
    ])
  })
})

describe('diffCounts', () => {
  it('counts additions and removals', () => {
    expect(diffCounts(diffLines('a\nb\n', 'a\nc\nd\n'))).toEqual({ added: 2, removed: 1 })
  })
})

describe('foldUnchanged', () => {
  const same = (text: string) => ({ kind: 'same' as const, text })
  const add = (text: string) => ({ kind: 'add' as const, text })
  const del = (text: string) => ({ kind: 'del' as const, text })
  const fold = (count: number) => ({ kind: 'fold' as const, count })
  const run = (n: number, prefix = 's') =>
    Array.from({ length: n }, (_, i) => same(`${prefix}${i}`))

  it('keeps context either side of a change and folds the rest', () => {
    const diff = [...run(10, 'a'), del('x'), add('y'), ...run(10, 'b')]
    expect(foldUnchanged(diff, 2)).toEqual([
      fold(8),
      same('a8'),
      same('a9'),
      del('x'),
      add('y'),
      same('b0'),
      same('b1'),
      fold(8),
    ])
  })

  it('leaves a short run whole rather than folding one line', () => {
    const diff = [del('x'), ...run(3), add('y')]
    expect(foldUnchanged(diff, 1)).toEqual(diff)
    // Exactly one more than the context it owes: still not worth a marker.
    expect(foldUnchanged([del('x'), ...run(3)], 2)).toEqual([del('x'), ...run(3)])
    expect(foldUnchanged([del('x'), ...run(4)], 2)).toEqual([
      del('x'),
      same('s0'),
      same('s1'),
      fold(2),
    ])
  })

  it('returns an all-unchanged diff as one fold', () => {
    expect(foldUnchanged(run(5))).toEqual([fold(5)])
    expect(foldUnchanged([])).toEqual([])
  })
})
