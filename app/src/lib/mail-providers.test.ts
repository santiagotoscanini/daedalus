import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { PROVIDER_LOGOS, relayProvider } from './mail-providers'

describe('relayProvider', () => {
  it('names a provider by its own submission host', () => {
    expect(relayProvider('smtp.gmail.com')).toEqual({ label: 'Gmail', logo: '/icon-gmail.svg' })
    expect(relayProvider(' SMTP.Gmail.com ')?.label).toBe('Gmail')
  })

  it('names nothing it was not told about, and nothing from a suffix', () => {
    expect(relayProvider('smtp.example.org')).toBeNull()
    expect(relayProvider('relay.gmail.com.example.org')).toBeNull()
    expect(relayProvider('')).toBeNull()
    expect(relayProvider(null)).toBeNull()
  })

  it('points every mark at a file under public/', () => {
    const missing = PROVIDER_LOGOS.filter((p) => !existsSync(join(__dirname, '../../public', p)))
    expect(missing).toEqual([])
  })
})
