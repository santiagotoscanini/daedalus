import { describe, expect, it } from 'vitest'
import { stripAnsi } from './ansi'

describe('stripAnsi', () => {
  it('removes colours, cursor moves and hyperlinks, keeping the glyphs', () => {
    const esc = String.fromCharCode(0x1b)
    const bel = String.fromCharCode(0x07)
    const coloured = `${esc}[32m✓${esc}[39m built ${esc}[1;36m❯${esc}[0m next ${esc}[2K│ done`
    expect(stripAnsi(coloured)).toBe('✓ built ❯ next │ done')
    expect(stripAnsi(`${esc}]8;;https://x.io${bel}link${esc}]8;;${bel}`)).toBe('link')
    expect(stripAnsi(`${esc}]0;title${esc}\\after`)).toBe('after')
    expect(stripAnsi(`${String.fromCharCode(0x9b)}31mred`)).toBe('red')
  })
})
