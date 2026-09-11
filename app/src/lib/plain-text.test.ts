import { describe, expect, it } from 'vitest'
import { decodeEntities, stripComments, stripTags } from './plain-text'

describe('decodeEntities', () => {
  it('decodes the entities the sources use', () => {
    expect(decodeEntities('a &lt;b&gt; &amp; &quot;c&quot; &#39;d&#39;&nbsp;e &#8212; f')).toBe(
      `a <b> & "c" 'd' e — f`,
    )
  })

  it('decodes once: an escaped entity stays an entity', () => {
    expect(decodeEntities('&amp;lt;tag&amp;gt;')).toBe('&lt;tag&gt;')
  })

  it('leaves unknown entities alone', () => {
    expect(decodeEntities('&copy; &#x27;')).toBe('&copy; &#x27;')
  })
})

describe('stripTags', () => {
  it('removes tags and keeps the text', () => {
    expect(stripTags('<p>Fix <code>VACUUM</code> on <a href="x">tables</a></p>')).toBe(
      'Fix VACUUM on tables',
    )
  })

  it('leaves no tag behind when tags nest inside tags', () => {
    expect(stripTags('<<b>i>x</i>')).not.toMatch(/<[^>]+>/)
  })
})

describe('stripComments', () => {
  it('removes comments on one line and across lines', () => {
    expect(stripComments('a<!-- one -->b<!--\ntwo\n-->c')).toBe('abc')
  })

  it('removes a comment closed with --!> and one never closed', () => {
    expect(stripComments('a<!-- x --!>b')).toBe('ab')
    expect(stripComments('a<!-- open to the end')).toBe('a')
  })

  it('removes a comment spliced together by removing another', () => {
    expect(stripComments('<!<!-- x -->-- y -->z')).toBe('z')
  })
})
