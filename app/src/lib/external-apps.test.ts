import { describe, expect, it } from 'vitest'
import { DEFAULT_EXTERNAL_APPS, isExternalAppList } from './external-apps'

// The guard is what stands between a hand-written `apps.external` row and a
// component: a row it accepts renders, a row it rejects degrades to the seed.

describe('isExternalAppList', () => {
  it('accepts the seed', () => {
    expect(isExternalAppList(DEFAULT_EXTERNAL_APPS)).toBe(true)
  })

  it('accepts an empty list', () => {
    expect(isExternalAppList([])).toBe(true)
  })

  it('rejects a platform this build does not know', () => {
    const row = { ...DEFAULT_EXTERNAL_APPS[0], platform: 'Netlify' }
    expect(isExternalAppList([row])).toBe(false)
  })

  it('rejects a missing host and a non-string repo', () => {
    const { host: _host, ...noHost } = DEFAULT_EXTERNAL_APPS[0] ?? {}
    expect(isExternalAppList([noHost])).toBe(false)
    expect(isExternalAppList([{ ...DEFAULT_EXTERNAL_APPS[0], repo: 42 }])).toBe(false)
  })

  it('rejects anything that is not a list of objects', () => {
    expect(isExternalAppList(null)).toBe(false)
    expect(isExternalAppList({})).toBe(false)
    expect(isExternalAppList(['santree'])).toBe(false)
  })
})
