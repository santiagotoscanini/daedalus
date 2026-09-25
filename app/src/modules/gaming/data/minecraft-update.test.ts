import { describe, expect, it } from 'vitest'
import { compareVersions, htmlSections } from './minecraft-update'

describe('compareVersions', () => {
  it('orders part by part, numerically', () => {
    expect(compareVersions('26.10', '26.9')).toBeGreaterThan(0)
    expect(compareVersions('26.3', '26.2')).toBeGreaterThan(0)
    expect(compareVersions('1.21.11', '26.1')).toBeLessThan(0)
    expect(compareVersions('26.1', '26.1.0')).toBe(0)
  })
})

describe('htmlSections', () => {
  it('reduces Mojang’s headings and bullets to sections, nested lists flattened', () => {
    const html =
      '<p>Intro<h1>New Features</h1><ul><li>Added <b>Poplar</b> Trees<li>Added Cushions &amp; Beds</ul>' +
      '<h2>Dappled Forest</h2><ul><li>Cold biome<ul><li>Sheep</ul></ul><h2>Empty</h2><p>prose only'
    expect(htmlSections(html)).toEqual({
      sections: [
        { name: 'New Features', items: ['Added Poplar Trees', 'Added Cushions & Beds'] },
        { name: 'Dappled Forest', items: ['Cold biome', 'Sheep'] },
      ],
      truncated: false,
    })
  })

  it('caps bullets per section and says so', () => {
    const many = Array.from({ length: 20 }, (_, i) => `<li>item ${String(i)}`).join('')
    const out = htmlSections(`<h1>Fixes</h1><ul>${many}</ul>`)
    expect(out.sections[0]?.items).toHaveLength(12)
    expect(out.truncated).toBe(true)
  })
})
