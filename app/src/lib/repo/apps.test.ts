import { describe, expect, it } from 'vitest'
import type { ManifestEntry } from '../nix-manifest'
import { renderRegistryFile } from '../registry-file'
import {
  type AppRecord,
  driftOf,
  toRegistryExport,
  toRow,
  validateAppPatch,
  validateNewApp,
} from './apps'

// The registry's central invariant, stated in api.registry.export.ts and
// checked nowhere until now: export → render → parse → import → export must be
// lossless, and every field the export emits must register in driftOf when it
// changes. A field exported but not compared is an edit that never lights the
// Apply bar and silently never ships — the exact bug this file exists to keep
// dead.

const NOW = new Date('2026-01-01T00:00:00Z')

/** A registry entry exercising every exported field with a non-default value. */
const RICH: ManifestEntry = {
  name: 'demo',
  managedInNix: false,
  operatorSecrets: false,
  stage: 'live',
  postgres: true,
  storage: true,
  litellm: true,
  prometheus: true,
  hostname: 'films.toscanini.me',
  image: 'registry.toscanini.me/demo@sha256:abc',
  egress: { container: 'gluetun-argus', hostPort: 8081 },
  env: [
    { key: 'A', value: '1', note: 'first' },
    { key: 'B', value: '2', note: null },
  ],
  auth: {
    mode: 'proxy',
    healthPath: '/api/healthz',
    isolated: true,
    allowedGroups: ['admins'],
    bypassRule: 'PathPrefix(`/api/hook`)',
  },
  presentation: { description: 'the rich fixture' },
  resources: { cpus: 1.5, memoryMb: 512, pids: 200 },
  notes: { stage: 'went live 2025-12', image: 'pinned for the migration' },
}

let seq = 0
function recordOf(entry: ManifestEntry): AppRecord {
  seq += 1
  const id = `app-${String(seq)}`
  return {
    id,
    ...toRow(entry),
    createdAt: NOW,
    updatedAt: NOW,
    envVars: entry.env.map((e, i) => ({
      id: `${id}-env-${String(i)}`,
      appId: id,
      key: e.key,
      value: e.value,
      note: e.note ?? null,
      position: i,
    })),
  }
}

/** What declarations.nix (and importFromNix) would read back from the file. */
function reparse(bytes: string): ManifestEntry[] {
  const parsed = JSON.parse(bytes) as {
    apps: Record<string, Omit<ManifestEntry, 'name' | 'managedInNix' | 'operatorSecrets'>>
  }
  return Object.entries(parsed.apps).map(([name, a]) => ({
    ...a,
    name,
    managedInNix: false,
    operatorSecrets: false,
  }))
}

describe('the export round-trip', () => {
  it('is byte-identical after export → render → parse → import → export', () => {
    const first = renderRegistryFile(toRegistryExport([recordOf(RICH)]))
    const second = renderRegistryFile(toRegistryExport(reparse(first).map(recordOf)))
    expect(second).toBe(first)
  })

  it('excludes nix-managed rows — daedalus itself never rides the export', () => {
    const managed = recordOf({ ...RICH, name: 'daedalus' })
    managed.managedInNix = true
    const out = toRegistryExport([managed, recordOf(RICH)])
    expect(Object.keys(out.apps)).toEqual(['demo'])
  })
})

describe('driftOf', () => {
  it('reports no drift across its own round trip', () => {
    const record = recordOf(RICH)
    const [entry] = reparse(renderRegistryFile(toRegistryExport([record])))
    expect(entry).toBeDefined()
    expect(driftOf(record, entry)).toEqual([])
  })

  it('flags an app nix has not built yet', () => {
    expect(driftOf(recordOf(RICH), undefined)).toEqual(['not in the last Nix build'])
  })

  it('flags every field the export emits — the coverage guard', () => {
    const record = recordOf(RICH)
    const clean = renderRegistryFile(toRegistryExport([record]))

    // Walk every leaf of the exported app object; each mutation must register.
    const paths: string[][] = []
    const walk = (v: unknown, path: string[]): void => {
      if (Array.isArray(v)) {
        v.forEach((item, i) => {
          walk(item, [...path, String(i)])
        })
      } else if (v !== null && typeof v === 'object') {
        for (const [k, child] of Object.entries(v)) walk(child, [...path, k])
      } else {
        paths.push(path)
      }
    }
    const cleanApp = (JSON.parse(clean) as { apps: Record<string, unknown> }).apps.demo
    walk(cleanApp, [])
    expect(paths.length).toBeGreaterThan(20)

    for (const path of paths) {
      const doc = JSON.parse(clean) as { apps: Record<string, unknown> }
      // biome-ignore lint/suspicious/noExplicitAny: navigating a parsed fixture by path.
      let cursor: any = doc.apps.demo
      for (const step of path.slice(0, -1)) cursor = cursor[step]
      const leaf = path[path.length - 1] as string
      const old: unknown = cursor[leaf]
      cursor[leaf] =
        typeof old === 'boolean'
          ? !old
          : typeof old === 'number'
            ? old + 1
            : `${String(old ?? '')}-mutated`

      const [entry] = reparse(JSON.stringify(doc))
      expect(entry).toBeDefined()
      expect(
        driftOf(record, entry),
        `mutating ${path.join('.')} must register as drift`,
      ).not.toEqual([])
    }
  })

  it('treats a notes key reorder as no drift — jsonb does not keep order', () => {
    const record = recordOf(RICH)
    const [entry] = reparse(renderRegistryFile(toRegistryExport([record])))
    expect(entry).toBeDefined()
    const reordered = {
      ...(entry as ManifestEntry),
      notes: Object.fromEntries(Object.entries((entry as ManifestEntry).notes ?? {}).reverse()),
    }
    expect(driftOf(record, reordered)).toEqual([])
  })

  it('treats an env reorder as drift — position is authored, nix would sort it', () => {
    const record = recordOf(RICH)
    const [entry] = reparse(renderRegistryFile(toRegistryExport([record])))
    expect(entry).toBeDefined()
    const swapped = { ...(entry as ManifestEntry) }
    swapped.env = [...swapped.env].reverse()
    expect(driftOf(record, swapped)).toContain('env')
  })

  it('validateAppPatch accepts well-typed fields and refuses the rest', () => {
    expect(
      validateAppPatch({ stage: 'live', postgres: true, limitCpus: 1.5, image: null }),
    ).toEqual({ stage: 'live', postgres: true, limitCpus: 1.5, image: null })

    expect(() => validateAppPatch({ stage: 'production' })).toThrow('off | lab | live')
    expect(() => validateAppPatch({ authMode: 'oauth' })).toThrow('none | proxy | native')
    expect(() => validateAppPatch({ postgres: 'yes' })).toThrow('boolean')
    expect(() => validateAppPatch({ limitCpus: -1 })).toThrow('positive')
    expect(() => validateAppPatch({ limitMemoryMb: 1.5 })).toThrow('positive integer')
    expect(() => validateAppPatch({ image: 7 })).toThrow('string or null')
    expect(() => validateAppPatch({ name: 'other' })).toThrow('not an editable field')
    expect(() => validateAppPatch({ managedInNix: true })).toThrow('not an editable field')
  })

  it('validateNewApp accepts the create shape and refuses the rest', () => {
    const good = {
      name: 'demo',
      description: 'x',
      stage: 'lab',
      postgres: true,
      storage: false,
      litellm: false,
      prometheus: false,
      image: null,
      hostname: null,
    }
    expect(validateNewApp(good)).toEqual(good)
    expect(() => validateNewApp({ ...good, stage: 'prod' })).toThrow('off | lab | live')
    expect(() => validateNewApp({ ...good, name: 7 })).toThrow('name must be a string')
    expect(() => validateNewApp({ ...good, postgres: 'yes' })).toThrow('boolean')
    expect(() => validateNewApp({ ...good, hostname: 7 })).toThrow('string or null')
  })

  it('does not collapse value/note ambiguity — k=v#n as a value is not a note', () => {
    const a = recordOf({
      ...RICH,
      name: 'amb',
      env: [{ key: 'K', value: 'v#n', note: null }],
    })
    const [entry] = reparse(
      renderRegistryFile(
        toRegistryExport([
          recordOf({ ...RICH, name: 'amb', env: [{ key: 'K', value: 'v', note: 'n' }] }),
        ]),
      ),
    )
    expect(entry).toBeDefined()
    expect(driftOf(a, entry)).toContain('env')
  })
})
