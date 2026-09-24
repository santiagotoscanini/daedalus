import { describe, expect, it } from 'vitest'
import { moduleChangeWords, siteBarFields, webChangeWords } from './module-switch'

describe('the Apply bar words for a switch', () => {
  it('names each moved id, and a removed entry as the host’s word', () => {
    expect(moduleChangeWords({ n8n: false }, { n8n: false, metube: true })).toEqual(['metube on'])
    expect(moduleChangeWords({ n8n: false }, {})).toEqual(['n8n as the host says'])
    expect(moduleChangeWords(undefined, { n8n: false })).toEqual(['n8n off'])
  })

  it('names a moved hostname and a moved exposure, each on its own', () => {
    expect(webChangeWords({}, { grocy: { label: 'pantry', public: null } })).toEqual([
      'grocy at pantry',
    ])
    expect(webChangeWords({}, { grocy: { label: null, public: true } })).toEqual(['grocy public'])
    expect(
      webChangeWords(
        { grocy: { label: 'pantry', public: true } },
        { grocy: { label: null, public: false } },
      ),
    ).toEqual(['grocy at its own name', 'grocy on the LAN only'])
    expect(webChangeWords({ grocy: { label: null, public: true } }, {})).toEqual([
      'grocy exposed as the host says',
    ])
    expect(webChangeWords(undefined, { a: { label: 'x', public: null } })).toEqual(['a at x'])
  })

  it('keeps the two object fields out of the bar, spelled out instead', () => {
    expect(siteBarFields(['mail.sender', 'modules.enabled', 'modules.web'], ['n8n off'])).toEqual([
      'mail.sender',
      'n8n off',
    ])
  })
})
