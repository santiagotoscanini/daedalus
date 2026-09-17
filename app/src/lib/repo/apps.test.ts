import { describe, expect, it } from 'vitest'
import type { ManifestEntry } from '../../host/nix-manifest'
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
  // Frozen — the non-default, so the round trip proves the value survives
  // rather than being regenerated from the platform default.
  deploy: { enable: false },
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
  // Two, in a deliberately non-alphabetical order, with a multi-word argv.
  // One task would not show a reordering at all, and `command` is the one
  // exported field that is an array of its own — the coverage walk below
  // mutates each element separately.
  tasks: [
    {
      id: 'digest',
      schedule: '*-*-* 04:23:00',
      command: ['node', 'scripts/digest.mjs'],
      timeoutSec: 900,
    },
    {
      id: 'cleanup',
      schedule: '*:41:00',
      command: ['bin/prune', '--older-than', '30d'],
      timeoutSec: 120,
    },
  ],
  notes: { stage: 'went live 2025-12', image: 'pinned for the migration' },
}

let seq = 0
function recordOf(entry: ManifestEntry): AppRecord {
  seq += 1
  const id = `app-${String(seq)}`
  return {
    id,
    ...toRow(entry),
    githubRepoId: null,
    buildStrategy: 'auto',
    buildPublish: 'live',
    buildEnvPlaceholders: {},
    railpackEnv: {},
    buildOnBox: false,
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
    tasks: (entry.tasks ?? []).map((t, i) => ({
      id: `${id}-task-${String(i)}`,
      appId: id,
      taskId: t.id,
      schedule: t.schedule,
      command: t.command,
      timeoutSec: t.timeoutSec,
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

// The build columns are engine state nix never reads. If one leaked into the
// export, every app would show drift the moment a build recorded its repo id,
// and the Apply bar would light for an edit that ships nothing.
describe('engine-only columns', () => {
  const plain = recordOf(RICH)
  const built: AppRecord = {
    ...plain,
    githubRepoId: 987_654_321,
    buildStrategy: 'dockerfile',
    buildPublish: 'candidate',
    buildEnvPlaceholders: { VITE_PUBLIC_KEY: 'placeholder', DATABASE_URL: 'postgres://build' },
    railpackEnv: { RAILPACK_NODE_PLAYWRIGHT_INSTALL: 'true' },
    buildOnBox: true,
  }

  it('render byte-identical apps.json', () => {
    expect(renderRegistryFile(toRegistryExport([built]))).toBe(
      renderRegistryFile(toRegistryExport([plain])),
    )
  })

  it('show no drift against the applied registry', () => {
    const [entry] = reparse(renderRegistryFile(toRegistryExport([plain])))
    expect(entry).toBeDefined()
    expect(driftOf(built, entry)).toEqual([])
  })

  // Build on this box is the switch an operator flips per app (plan step 7):
  // turning it on must not read as a registry change waiting for Apply.
  it('show no drift with Build on this box on, and none when only it changes', () => {
    const [entry] = reparse(renderRegistryFile(toRegistryExport([plain])))
    expect(entry).toBeDefined()
    expect(driftOf({ ...plain, buildOnBox: true }, entry)).toEqual([])
    expect(driftOf({ ...plain, buildOnBox: false }, entry)).toEqual([])
    expect(renderRegistryFile(toRegistryExport([{ ...plain, buildOnBox: true }]))).toBe(
      renderRegistryFile(toRegistryExport([{ ...plain, buildOnBox: false }])),
    )
  })

  it('survive a re-sync from Nix — toRow never carries them', () => {
    const row = toRow(RICH)
    for (const k of [
      'githubRepoId',
      'buildStrategy',
      'buildPublish',
      'buildEnvPlaceholders',
      'railpackEnv',
      'buildOnBox',
    ]) {
      expect(row).not.toHaveProperty(k)
    }
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

  // Same rule as env, and the consequence is sharper: a task's position is
  // what the generated unit list is built from, so a reorder that read as "no
  // drift" would leave the box running the previous order forever.
  it('treats a task reorder as drift — position is authored, nix would sort it', () => {
    const record = recordOf(RICH)
    const [entry] = reparse(renderRegistryFile(toRegistryExport([record])))
    expect(entry).toBeDefined()
    const swapped = { ...(entry as ManifestEntry) }
    swapped.tasks = [...(swapped.tasks ?? [])].reverse()
    expect(driftOf(record, swapped)).toContain('tasks')
  })

  // The argv rule: two different commands must never compare equal. Joining
  // on a space (the obvious shortcut) collapses these two into one string.
  it('tells `["echo","a b"]` apart from `["echo","a","b"]`', () => {
    const record = recordOf(RICH)
    const [entry] = reparse(renderRegistryFile(toRegistryExport([record])))
    expect(entry).toBeDefined()
    const regrouped = {
      ...(entry as ManifestEntry),
      tasks: [
        {
          id: 'digest',
          schedule: '*-*-* 04:23:00',
          command: ['node scripts/digest.mjs'],
          timeoutSec: 900,
        },
        ...((entry as ManifestEntry).tasks ?? []).slice(1),
      ],
    }
    expect(driftOf(record, regrouped)).toContain('tasks')
  })

  // The tolerant-reader half of the contract: apps.json as it exists on the
  // box today has no `tasks` key at all, and an app with no tasks must not
  // light the Apply bar the moment this field ships.
  it('shows no drift when an app has no tasks and the file predates the field', () => {
    const plain = recordOf({ ...RICH, tasks: [] })
    const [entry] = reparse(renderRegistryFile(toRegistryExport([plain])))
    expect(entry).toBeDefined()
    const { tasks: _dropped, ...withoutTasks } = entry as ManifestEntry
    expect(driftOf(plain, withoutTasks as ManifestEntry)).toEqual([])
  })

  it('validateAppPatch accepts well-typed fields and refuses the rest', () => {
    expect(
      validateAppPatch({ stage: 'live', postgres: true, limitCpus: 1.5, image: null }),
    ).toEqual({ stage: 'live', postgres: true, limitCpus: 1.5, image: null })

    // The promote patch, which is how an app leaves `declared`, and the
    // demote back to it — both plain stage edits.
    expect(validateAppPatch({ stage: 'declared' })).toEqual({ stage: 'declared' })
    expect(() => validateAppPatch({ stage: 'production' })).toThrow('declared | off | lab | live')
    expect(() => validateAppPatch({ authMode: 'oauth' })).toThrow('none | proxy | native')
    expect(() => validateAppPatch({ postgres: 'yes' })).toThrow('boolean')
    expect(() => validateAppPatch({ deployEnable: 'frozen' })).toThrow('boolean')
    expect(validateAppPatch({ deployEnable: false })).toEqual({ deployEnable: false })
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
      postgres: true,
      storage: false,
      litellm: false,
      prometheus: false,
      image: null,
      hostname: null,
    }
    expect(validateNewApp(good)).toEqual(good)
    // A new app is born `declared` — there is nothing to choose, and a caller
    // asking for anything else is told so rather than quietly given a row that
    // would fail its first Apply.
    expect(validateNewApp({ ...good, stage: 'declared' })).toEqual(good)
    expect(() => validateNewApp({ ...good, stage: 'live' })).toThrow('cannot be chosen at create')
    expect(() => validateNewApp({ ...good, stage: 'lab' })).toThrow('Promote it')
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

// `tasks` rides the same patch as every editable column (there is no task
// server function — saveApp already carries the assertAdmin gate), so this is
// the boundary that keeps a malformed task out of the registry. Refusals are
// asserted on the sentence, because the sentence is what the operator reads:
// each one names the task and the rule rather than "invalid input".
describe('validateAppPatch accepts a task list', () => {
  const task = (over: Record<string, unknown> = {}) => ({
    id: 'digest',
    schedule: '*-*-* 04:23:00',
    command: ['node', 'scripts/digest.mjs'],
    timeoutSec: 900,
    ...over,
  })

  it('normalises what it accepts and keeps authored order', () => {
    const out = validateAppPatch({
      tasks: [task({ id: ' Digest ', schedule: ' *-*-* 04:23:00 ' }), task({ id: 'prune' })],
    })
    expect(out.tasks).toEqual([
      {
        id: 'digest',
        schedule: '*-*-* 04:23:00',
        command: ['node', 'scripts/digest.mjs'],
        timeoutSec: 900,
      },
      {
        id: 'prune',
        schedule: '*-*-* 04:23:00',
        command: ['node', 'scripts/digest.mjs'],
        timeoutSec: 900,
      },
    ])
  })

  it('accepts an empty list — that is how the last task is removed', () => {
    expect(validateAppPatch({ tasks: [] })).toEqual({ tasks: [] })
  })

  it('refuses an id that could name a unit other than its own', () => {
    expect(() => validateAppPatch({ tasks: [task({ id: 'with space' })] })).toThrow(
      /systemd unit name/,
    )
    expect(() => validateAppPatch({ tasks: [task({ id: 'with.dot' })] })).toThrow(
      /systemd unit name/,
    )
    expect(() => validateAppPatch({ tasks: [task({ id: '../etc' })] })).toThrow(/systemd unit name/)
    expect(() => validateAppPatch({ tasks: [task({ id: '' })] })).toThrow(/pick an id first/)
  })

  it('refuses two tasks with one id', () => {
    expect(() => validateAppPatch({ tasks: [task(), task()] })).toThrow(
      /digest is already a task on this app/,
    )
  })

  it('refuses a command that is not a non-empty argv of non-empty strings', () => {
    expect(() => validateAppPatch({ tasks: [task({ command: [] })] })).toThrow(
      /give it something to run/,
    )
    expect(() => validateAppPatch({ tasks: [task({ command: ['node', ''] })] })).toThrow(
      /argument 2 is empty/,
    )
    expect(() => validateAppPatch({ tasks: [task({ command: 'node x.mjs' })] })).toThrow(
      /argv, not a shell line/,
    )
  })

  it('refuses a timeout that is not a positive integer', () => {
    expect(() => validateAppPatch({ tasks: [task({ timeoutSec: 0 })] })).toThrow(
      /whole number of seconds above zero/,
    )
    expect(() => validateAppPatch({ tasks: [task({ timeoutSec: 90.5 })] })).toThrow(
      /whole number of seconds above zero/,
    )
    expect(() => validateAppPatch({ tasks: [task({ timeoutSec: null })] })).toThrow(
      /must be a number of seconds/,
    )
  })

  // The shorthands are valid systemd and still refused: they elapse at :00,
  // inside myspeed's house-wide DNS blackout, where a starved run can still
  // report success. The UI expands its presets to a concrete OnCalendar on the
  // app's own minute; this is the backstop for everything that is not the UI.
  it('refuses the systemd shorthands and an empty schedule', () => {
    for (const schedule of ['hourly', 'daily', 'weekly', 'monthly']) {
      expect(() => validateAppPatch({ tasks: [task({ schedule })] }), schedule).toThrow(
        /fires exactly on the hour/,
      )
    }
    expect(() => validateAppPatch({ tasks: [task({ schedule: '' })] })).toThrow(
      /pick a schedule first/,
    )
  })

  it('refuses a tasks value that is not a list of task objects', () => {
    expect(() => validateAppPatch({ tasks: { id: 'digest' } })).toThrow(
      /must be an array of scheduled tasks/,
    )
    expect(() => validateAppPatch({ tasks: ['digest'] })).toThrow(
      /must be an object with id, schedule, command and timeoutSec/,
    )
  })
})
