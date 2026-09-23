import { describe, expect, it } from 'vitest'
import { MODULES, moduleById, resolveModuleTab } from './registry'

// The registry is a glob over real directories, so these run against the
// modules actually shipped: what they assert is the contract every module
// directory has to keep, not a fixture.

describe('the module registry', () => {
  it('finds the nine modules, in rail order', () => {
    expect(MODULES.map((m) => m.id)).toEqual([
      'ai',
      'media',
      'home',
      'gaming',
      'network',
      'system',
      'database',
      'actions',
      'monitoring',
    ])
  })

  it('gives every module at least one tab, with unique ids', () => {
    for (const m of MODULES) {
      expect(m.tabs.length, m.id).toBeGreaterThan(0)
      expect(new Set(m.tabs.map((t) => t.id)).size, m.id).toBe(m.tabs.length)
    }
  })

  it('resolves an unknown tab to the first one, and an unknown module to nothing', () => {
    expect(resolveModuleTab('gaming', undefined)).toBe('factorio')
    expect(resolveModuleTab('gaming', 'minecraft')).toBe('minecraft')
    expect(resolveModuleTab('gaming', 'chess')).toBe('factorio')
    expect(resolveModuleTab('chess', 'x')).toBe('')
    expect(moduleById('chess')).toBeUndefined()
  })
})
