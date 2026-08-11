import { describe, expect, it } from 'vitest'
import type { ManifestApp } from './nix-manifest'
import { renderRegistryFile } from './registry-file'

const APP: ManifestApp = {
  stage: 'lab',
  postgres: true,
  storage: false,
  litellm: false,
  prometheus: false,
  hostname: null,
  image: null,
  egress: null,
  env: [],
  auth: { mode: 'none' },
  presentation: { description: 'test app' },
}

describe('renderRegistryFile', () => {
  it('renders stable, diffable bytes: preamble first, 2-space indent, trailing newline', () => {
    const out = renderRegistryFile({ schemaVersion: 1, apps: { demo: APP } })
    expect(out.endsWith('}\n')).toBe(true)
    const keys = Object.keys(JSON.parse(out) as Record<string, unknown>)
    expect(keys).toEqual(['_generated', '_why', 'schemaVersion', 'apps'])
    expect(out).toContain('\n  "schemaVersion": 1')
  })

  it('is deterministic — the same registry renders the same bytes', () => {
    const a = renderRegistryFile({ schemaVersion: 1, apps: { demo: APP } })
    const b = renderRegistryFile({ schemaVersion: 1, apps: { demo: APP } })
    expect(a).toBe(b)
  })

  it('round-trips through JSON.parse without loss', () => {
    const out = renderRegistryFile({ schemaVersion: 1, apps: { demo: APP } })
    const parsed = JSON.parse(out) as { schemaVersion: number; apps: Record<string, ManifestApp> }
    expect(parsed.schemaVersion).toBe(1)
    expect(parsed.apps.demo).toEqual(APP)
  })
})
