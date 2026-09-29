import { describe, expect, it } from 'vitest'
import { LINK_UNKNOWN, linkWords } from './node-link'

describe('linkWords', () => {
  it('says connected, not connected with when, or unknown — never "not connected" for unknown', () => {
    expect(linkWords({ connected: true, lastSeenAgo: 5 })).toBe('connected')
    expect(linkWords({ connected: false, lastSeenAgo: 600 })).toBe(
      'not connected · last heard 10 min ago',
    )
    expect(linkWords({ connected: null, lastSeenAgo: 600 })).toBe(LINK_UNKNOWN)
  })
})
