import { describe, expect, it } from 'vitest'
import { activeModules, type ModuleState } from './active'
import type { ModuleManifest } from './manifest'

const m = (id: string, tabs: ModuleManifest['tabs']): ModuleManifest => ({
  id,
  label: id,
  lede: '',
  order: 1,
  boardSpans: [12],
  tabs,
})

const stateOf =
  (states: Record<string, ModuleState>) =>
  (id: string): ModuleState =>
    states[id] ?? 'on'

describe('activeModules', () => {
  const modules = [
    m('media', [
      { id: 'jellyfin', label: 'Jellyfin', nix: 'tv' },
      { id: 'calibre', label: 'Calibre', nix: 'calibre-web' },
      { id: 'wanted', label: 'Wanted', nix: ['tv', 'seerr'] },
    ]),
    m('system', [{ id: 'host', label: 'Host' }]),
  ]

  it('keeps everything when nothing is denied', () => {
    expect(activeModules(modules, () => 'on')).toEqual(modules)
  })

  it('drops a tab whose every nix module is absent, and keeps one with any of them on', () => {
    const active = activeModules(modules, stateOf({ tv: 'absent' }))
    expect(active.map((x) => x.id)).toEqual(['media', 'system'])
    // wanted survives on seerr; jellyfin fronts tv alone and goes
    expect(active[0]?.tabs.map((t) => t.id)).toEqual(['calibre', 'wanted'])
  })

  it('keeps a tab whose nix modules are declared and off, marked off', () => {
    const active = activeModules(modules, stateOf({ tv: 'off' }))
    expect(active[0]?.tabs.map((t) => [t.id, t.off ?? false])).toEqual([
      ['jellyfin', true],
      ['calibre', false],
      ['wanted', false],
    ])
  })

  it('marks a tab off only when every nix module it fronts is off', () => {
    const active = activeModules(modules, stateOf({ tv: 'off', seerr: 'off' }))
    expect(active[0]?.tabs.find((t) => t.id === 'wanted')?.off).toBe(true)
    // off beside absent is still off: the box declares one of them
    const mixed = activeModules(modules, stateOf({ tv: 'absent', seerr: 'off' }))
    expect(mixed[0]?.tabs.find((t) => t.id === 'wanted')?.off).toBe(true)
  })

  it('removes a module with no tab left, and never one whose tabs front nothing', () => {
    const active = activeModules(modules, () => 'absent')
    expect(active.map((x) => x.id)).toEqual(['system'])
  })

  it('does not mutate the manifests it filters', () => {
    const before = JSON.stringify(modules)
    activeModules(modules, stateOf({ tv: 'off', seerr: 'absent' }))
    expect(JSON.stringify(modules)).toBe(before)
  })
})
