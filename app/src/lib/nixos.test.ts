import { describe, expect, it } from 'vitest'
import {
  builtOn,
  latestCycle,
  type NixosCycle,
  notesFile,
  parseNixosNotes,
  supportOf,
} from './nixos'

const md = [
  '# Release 26.05 ("Yarara", 2026.05/30) {#sec-release-26.05}',
  '',
  '## Highlights {#sec-release-26.05-highlights}',
  '',
  '<!-- To avoid merge conflicts, consider adding your item at an arbitrary place in the list instead. -->',
  '',
  '- Stage 1 is now based on systemd by default.',
  '',
  '  You can revert by disabling [](#opt-boot.initrd.systemd.enable).',
  '',
  '  - A nested detail, not an item.',
  '',
  '- The `system.nix` file was added',
  '  as an alternative entry point. For example,',
  '  ```nix',
  '  { }',
  '  ```',
  '',
  '## New Modules {#sec-release-26.05-new-modules}',
  '',
  '- [Atuin](https://atuin.sh), shell history. Available as [programs.atuin](#opt-programs.atuin.enable).',
  '- [](#opt-services.autossh-ng.sessions) was introduced.',
  '',
  '## Nothing here {#sec-empty}',
  '',
].join('\n')

describe('parseNixosNotes', () => {
  it('reads first paragraphs of top-level items under each heading', () => {
    expect(parseNixosNotes(md)).toEqual({
      sections: [
        {
          name: 'Highlights',
          items: [
            'Stage 1 is now based on systemd by default.',
            'The system.nix file was added as an alternative entry point.',
          ],
        },
        {
          name: 'New Modules',
          items: [
            'Atuin, shell history. Available as programs.atuin.',
            'services.autossh-ng.sessions was introduced.',
          ],
        },
      ],
      truncated: false,
    })
  })

  it('caps each section and says so', () => {
    const out = parseNixosNotes(md, 1)
    expect(out.truncated).toBe(true)
    expect(out.sections.map((s) => s.items.length)).toEqual([1, 1])
  })
})

describe('support', () => {
  it('reads a support window against a day', () => {
    expect(supportOf('2026-06-30', '2026-09-11')).toEqual({
      state: 'ended',
      eol: '2026-06-30',
      days: -73,
    })
    expect(supportOf('2026-10-01', '2026-09-11')?.state).toBe('ending')
    expect(supportOf('2026-12-31', '2026-09-11')).toEqual({
      state: 'supported',
      eol: '2026-12-31',
      days: 111,
    })
    expect(supportOf('', '2026-09-11')).toBeNull()
  })

  it('picks the newest release already out', () => {
    const cycles: NixosCycle[] = [
      { cycle: '26.11', codename: '', releaseDate: '2026-11-30', eol: '2027-06-30' },
      { cycle: '25.11', codename: 'Xantusia', releaseDate: '2025-11-30', eol: '2026-06-30' },
      { cycle: '26.05', codename: 'Yarara', releaseDate: '2026-05-30', eol: '2026-12-31' },
    ]
    expect(latestCycle(cycles, '2026-09-11')?.cycle).toBe('26.05')
    expect(latestCycle(cycles, '2025-01-01')).toBeNull()
  })
})

describe('version strings', () => {
  it('finds the date and the notes file', () => {
    expect(builtOn('25.11.20260630.b6018f8')).toBe('2026-06-30')
    expect(builtOn('25.11pre-git')).toBeNull()
    expect(notesFile('26.05')).toBe('rl-2605.section.md')
    expect(notesFile('unstable')).toBeNull()
  })
})
