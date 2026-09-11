import { describe, expect, it } from 'vitest'
import { summarise } from './apply'

describe('summarise', () => {
  it('names a no-op re-export', () => {
    expect(summarise([])).toBe('no-op re-export')
  })

  it('names a single app and its fields', () => {
    expect(summarise([{ name: 'iris', fields: ['image', 'env'] }])).toBe('iris: image, env')
  })

  it('names only the fields of a site-only change, which the host prefixes', () => {
    expect(summarise([{ name: 'site', fields: ['timezone', 'mail'] }])).toBe('timezone, mail')
  })

  it('counts and names several changes', () => {
    expect(
      summarise([
        { name: 'iris', fields: ['image'] },
        { name: 'site', fields: ['timezone'] },
      ]),
    ).toBe('2 apps updated (iris, site)')
  })
})
