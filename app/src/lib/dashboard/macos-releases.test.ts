import { describe, expect, it } from 'vitest'

import {
  buildFor,
  compareVersions,
  notesSlugs,
  parsePmv,
  parseReleaseNotes,
  parseSecurityPage,
  parseSecurityTable,
  splitRunning,
  tableDate,
} from './macos-releases'

// Rows the way support.apple.com/100100 lays them out: three cells, the
// name a link in a paragraph, and beside it sometimes a sentence.
const cell = (inner: string) =>
  `<td class="gb-table-cell tablecell-align-left" colspan="1" rowspan="1"><p class="gb-paragraph">${inner}</p></td>`
const row = (name: string, href: string | null, avail: string, date: string, note = '') =>
  `<tr>${cell(
    (href === null ? name : `<a href="${href}" class="gb-anchor">${name}</a>`) + note,
  )}${cell(avail)}${cell(date)}</tr>`

const TABLE = `<table>${[
  row('macOS Golden Gate 27', 'https://support.apple.com/en-us/149035', 'macOS 27', '14 Sep 2026'),
  row('macOS Tahoe 26.7', 'https://support.apple.com/en-us/149042', 'macOS Tahoe', '14 Sep 2026'),
  row('Safari 27', 'https://support.apple.com/en-us/149050', 'macOS Tahoe', '14 Sep 2026'),
  row(
    'macOS Tahoe 26.6.2',
    'https://support.apple.com/en-us/148281',
    'macOS Tahoe',
    '17 Aug 2026',
    '</p><p class="gb-paragraph">This update has no published CVE entries.',
  ),
  row('macOS Tahoe 26.6.1', 'https://support.apple.com/en-us/148170', 'macOS Tahoe', '29 Jul 2026'),
  row('macOS Sequoia 15.7.9', null, 'macOS Sequoia', '29 Jul 2026'),
].join('')}</table>`

describe('the security table', () => {
  it('keeps the macOS rows, with name, version, date and link', () => {
    const rows = parseSecurityTable(TABLE)
    expect(rows.map((r) => `${r.name} ${r.version}`)).toEqual([
      'Golden Gate 27',
      'Tahoe 26.7',
      'Tahoe 26.6.2',
      'Tahoe 26.6.1',
      'Sequoia 15.7.9',
    ])
    expect(rows[0]?.date).toBe('2026-09-14')
    expect(rows[0]?.url).toBe('https://support.apple.com/en-us/149035')
    expect(rows[4]?.url).toBeNull()
  })

  it('carries the sentence Apple writes beside a name', () => {
    const rows = parseSecurityTable(TABLE)
    expect(rows[2]?.note).toBe('This update has no published CVE entries.')
    expect(rows[1]?.note).toBeNull()
  })

  it('reads the dates Apple prints', () => {
    expect(tableDate('17 Aug 2026')).toBe('2026-08-17')
    expect(tableDate('3 Sept 2026')).toBe('2026-09-03')
    expect(tableDate('soon')).toBeNull()
  })
})

describe('the security page', () => {
  it('counts distinct CVEs', () => {
    expect(
      parseSecurityPage(
        '<p>CVE-2026-1234: someone</p><p>CVE-2026-1234 again</p><p>CVE-2026-9999</p>',
      ),
    ).toEqual({ cves: 2, note: null })
  })
  it('keeps Apple’s line when there are none', () => {
    expect(parseSecurityPage('<p>This update has no published CVE entries.</p>')).toEqual({
      cves: 0,
      note: 'This update has no published CVE entries.',
    })
    expect(parseSecurityPage('<p>nothing</p>')).toEqual({ cves: null, note: null })
  })
})

describe('the version feed', () => {
  const PMV = JSON.stringify({
    PublicAssetSets: {
      macOS: [
        {
          ProductVersion: '27.0',
          Build: '26A428',
          PostingDate: '2026-09-15',
          SupportedDevices: ['J516sAP', 'J514sAP', 'J180dAP'],
        },
        {
          ProductVersion: '27.0',
          Build: '26A5428',
          PostingDate: '2026-09-15',
          SupportedDevices: ['J700AP'],
        },
        {
          ProductVersion: '26.7',
          Build: '25G229',
          PostingDate: '2026-09-15',
          SupportedDevices: ['J516sAP'],
        },
      ],
      iOS: [{ ProductVersion: '27.0', Build: '25A1', SupportedDevices: [] }],
    },
  })
  it('groups builds by version', () => {
    const v = parsePmv(PMV)
    expect([...v.keys()]).toEqual(['27.0', '26.7'])
    expect(v.get('27.0')?.map((b) => b.build)).toEqual(['26A428', '26A5428'])
  })
  it('picks the build for the Mac’s board, else the widest one', () => {
    const v = parsePmv(PMV)
    expect(buildFor(v.get('27.0'), 'J700AP')).toBe('26A5428')
    expect(buildFor(v.get('27.0'), 'J516sAP')).toBe('26A428')
    expect(buildFor(v.get('27.0'), null)).toBe('26A428')
    expect(
      buildFor(
        [
          { build: '26A5428', posted: null, devices: [] },
          { build: '26A428', posted: null, devices: [] },
        ],
        null,
      ),
    ).toBe('26A428')
    expect(buildFor(undefined, null)).toBeNull()
  })
})

describe('release notes', () => {
  const DOC = JSON.stringify({
    primaryContentSections: [
      {
        kind: 'content',
        content: [
          { type: 'heading', level: 2, text: 'Overview' },
          { type: 'paragraph', inlineContent: [{ type: 'text', text: 'The macOS 26.6 SDK…' }] },
          { type: 'heading', level: 3, text: 'CoreStorage' },
          { type: 'heading', level: 4, text: 'Deprecations' },
          {
            type: 'unorderedList',
            items: [
              {
                content: [
                  {
                    type: 'paragraph',
                    inlineContent: [
                      { type: 'text', text: 'Encrypted HFS+ is deprecated. ' },
                      { type: 'codeVoice', code: 'diskutil' },
                      { type: 'text', text: ' still lists it.  (175892336)' },
                    ],
                  },
                ],
              },
            ],
          },
          { type: 'heading', level: 3, text: 'Messages' },
          { type: 'heading', level: 4, text: 'Resolved Issues' },
          {
            type: 'unorderedList',
            items: [
              {
                content: [
                  {
                    type: 'paragraph',
                    inlineContent: [{ type: 'text', text: 'Fixed: a thing. (1)' }],
                  },
                ],
              },
              {
                content: [
                  {
                    type: 'paragraph',
                    inlineContent: [
                      { type: 'text', text: 'Fixed: another; see ' },
                      { type: 'reference', identifier: 'doc://x/documentation/foo' },
                      { type: 'text', text: '. (123456789) (FB22512943)' },
                    ],
                  },
                ],
              },
            ],
          },
        ],
      },
    ],
    references: { 'doc://x/documentation/foo': { title: 'the Foo guide' } },
  })
  it('folds headings and bullets into sections, radar numbers dropped', () => {
    expect(parseReleaseNotes(DOC)).toEqual([
      {
        area: 'CoreStorage',
        kind: 'Deprecations',
        items: ['Encrypted HFS+ is deprecated. diskutil still lists it.'],
      },
      {
        area: 'Messages',
        kind: 'Resolved Issues',
        items: ['Fixed: a thing. (1)', 'Fixed: another; see the Foo guide.'],
      },
    ])
  })
  it('names the page for a point release, then the major’s', () => {
    expect(notesSlugs('26.6.2')).toEqual(['macos-26_6-release-notes', 'macos-26-release-notes'])
    expect(notesSlugs('27.0')).toEqual(['macos-27_0-release-notes', 'macos-27-release-notes'])
  })
})

describe('versions', () => {
  it('compares as numbers, a bare major as .0', () => {
    expect(compareVersions('26.6.2', '26.6.1')).toBeGreaterThan(0)
    expect(compareVersions('27', '26.7')).toBeGreaterThan(0)
    expect(compareVersions('26.6', '26.6.0')).toBe(0)
    expect(compareVersions('26.10', '26.9')).toBeGreaterThan(0)
  })
  it('splits what the agent reports', () => {
    expect(splitRunning('26.6.1 (25G76)')).toEqual({ version: '26.6.1', build: '25G76' })
    expect(splitRunning('26.6.1')).toEqual({ version: '26.6.1', build: null })
  })
})
