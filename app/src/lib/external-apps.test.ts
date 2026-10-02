import { describe, expect, it } from 'vitest'
import { externalAppId } from './external-apps'

describe('externalAppId', () => {
  it('files a host under a slug that a bare app name cannot spell', () => {
    expect(externalAppId('Docs.Example.org')).toBe('docs-example-org')
    expect(externalAppId(' example.org ')).toBe('example-org')
  })
})
