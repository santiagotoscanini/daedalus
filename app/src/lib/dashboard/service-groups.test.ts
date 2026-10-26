import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { ICON_FILES, serviceGroups } from './service-groups'

// The grouping System › Updates draws: a stack is one decision, a bundle stack
// is not, and a pin that is not a container belongs to what it builds.

const stacks = {
  immich: ['immich', 'immich-postgres', 'immich-redis', 'immich-machine-learning'],
  tv: ['jellyfin', 'radarr', 'sonarr'],
  'app-db': ['pg', 'app-db-exporter'],
}

describe('serviceGroups', () => {
  it('folds a stack into one group and leaves a lone container its own', () => {
    const g = serviceGroups(stacks, [
      { kind: 'container', container: 'immich' },
      { kind: 'container', container: 'immich-redis' },
      { kind: 'container', container: 'traefik' },
    ])
    expect(g.map((x) => [x.id, x.members])).toEqual([
      ['immich', ['c:immich', 'c:immich-redis']],
      ['traefik', ['c:traefik']],
    ])
    expect(g[0]?.icon).toBe('/icon-immich.svg')
  })

  it('keeps the TV stack whole and folds the *arr helpers into it', () => {
    const g = serviceGroups(stacks, [
      { kind: 'container', container: 'jellyfin' },
      { kind: 'container', container: 'radarr' },
      { kind: 'container', container: 'recyclarr' },
      { kind: 'container', container: 'seerr' },
      { kind: 'container', container: 'mcp-grocy' },
      { kind: 'container', container: 'grocy' },
    ])
    expect(g.map((x) => [x.id, x.members])).toEqual([
      ['tv', ['c:jellyfin', 'c:radarr', 'c:recyclarr', 'c:seerr']],
      ['mcp-grocy', ['c:mcp-grocy']],
      ['grocy', ['c:grocy']],
    ])
    expect(g[0]?.icon).toBe('/icon-jellyfin.svg')
  })

  it('folds a sidecar stack into the service it serves', () => {
    const g = serviceGroups({ 'grocy-mcp': ['mcp-grocy'] }, [
      { kind: 'container', container: 'mcp-grocy' },
      { kind: 'container', container: 'grocy' },
    ])
    expect(g.map((x) => [x.id, x.members])).toEqual([['grocy', ['c:mcp-grocy', 'c:grocy']]])
  })

  it('files a manual pin under the service it builds, and the engine’s under daedalus', () => {
    const g = serviceGroups(stacks, [
      { kind: 'container', container: 'app-db-exporter' },
      { kind: 'manual', container: 'pg-pgvector', containers: ['pg'], engine: true },
      {
        kind: 'manual',
        container: 'app-daedalus-node',
        containers: ['app-daedalus'],
        engine: true,
      },
      { kind: 'manual', container: 'railpack', containers: [], engine: true },
    ])
    expect(g.map((x) => [x.id, x.label, x.members])).toEqual([
      ['app-db', 'Postgres', ['c:app-db-exporter', 'm:pg-pgvector']],
      ['daedalus', 'Daedalus', ['m:app-daedalus-node', 'm:railpack']],
    ])
    expect(g[0]?.icon).toBe('/icon-postgres.svg')
  })

  it('keeps a container and a manual pin of the same name apart', () => {
    const g = serviceGroups({}, [
      { kind: 'container', container: 'getbased' },
      { kind: 'manual', container: 'getbased', containers: ['getbased'], engine: false },
    ])
    expect(g).toHaveLength(1)
    expect(g[0]?.members).toEqual(['c:getbased', 'm:getbased'])
  })

  it('draws a monogram (null) for a service with no icon', () => {
    const g = serviceGroups({}, [{ kind: 'container', container: 'speedtest-tracker' }])
    expect(g[0]?.icon).toBeNull()
    expect(g[0]?.label).toBe('Speedtest Tracker')
  })
})

describe('ICON_FILES', () => {
  it('names only files that exist under public/', () => {
    const missing = Object.values(ICON_FILES).filter(
      (p) => !existsSync(join(__dirname, '../../../public', p)),
    )
    expect(missing).toEqual([])
  })
})
