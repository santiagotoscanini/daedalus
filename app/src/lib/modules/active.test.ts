import { describe, expect, it } from 'vitest'
import { activeModules } from './active'
import type { ModuleManifest } from './manifest'

const m = (id: string, tabs: ModuleManifest['tabs']): ModuleManifest => ({
  id,
  label: id,
  lede: '',
  order: 1,
  boardSpans: [12],
  tabs,
})

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
    expect(activeModules(modules, () => true)).toEqual(modules)
  })

  it('drops a tab whose every nix module is off, and keeps one with any of them on', () => {
    const active = activeModules(modules, (id) => id !== 'tv')
    expect(active.map((x) => x.id)).toEqual(['media', 'system'])
    // wanted survives on seerr; jellyfin fronts tv alone and goes
    expect(active[0]?.tabs.map((t) => t.id)).toEqual(['calibre', 'wanted'])
  })

  it('removes a module with no tab left, and never one whose tabs front nothing', () => {
    const active = activeModules(modules, () => false)
    expect(active.map((x) => x.id)).toEqual(['system'])
  })

  it('does not mutate the manifests it filters', () => {
    activeModules(modules, () => false)
    expect(modules[0]?.tabs).toHaveLength(3)
  })
})
