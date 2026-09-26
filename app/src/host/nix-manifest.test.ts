import { mkdtemp, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { REGISTRY_SCHEMA_VERSION } from '../lib/contract/version'
import { manifestEntries } from './nix-manifest'

// The two files the drift comparison reads: /export/apps.json (what only nix
// knows) and the applied registry.

const app = (stage: string) => ({
  stage,
  postgres: false,
  storage: false,
  litellm: false,
  prometheus: false,
  image: null,
  auth: { mode: 'proxy' },
  presentation: { description: '' },
})

let dir = ''

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'nix-manifest-'))
  vi.stubEnv('EXPORT_DIR', dir)
  vi.stubEnv('NIX_REGISTRY_PATH', join(dir, 'applied.json'))
  await writeFile(
    join(dir, 'applied.json'),
    JSON.stringify({ schemaVersion: REGISTRY_SCHEMA_VERSION, apps: { iris: app('live') } }),
  )
})

afterEach(() => vi.unstubAllEnvs())

const publishApps = (data: unknown) =>
  writeFile(
    join(dir, 'apps.json'),
    JSON.stringify({
      daedalusExport: 1,
      domain: 'apps',
      schemaVersion: 1,
      source: 'nix',
      generatedAt: new Date().toISOString(),
      data,
    }),
  )

describe('manifestEntries', () => {
  it('joins the registry with the nix-declared apps and the operator-secrets fact', async () => {
    await publishApps({ nixManaged: { daedalus: app('lab') }, operatorSecretApps: ['iris'] })
    const entries = await manifestEntries()
    expect(entries.map((e) => [e.name, e.managedInNix, e.operatorSecrets])).toEqual([
      ['daedalus', true, false],
      ['iris', false, true],
    ])
  })

  it('fails loudly on a malformed export rather than dropping daedalus', async () => {
    await publishApps({ nixManaged: { daedalus: { stage: 'lab' } } })
    await expect(manifestEntries()).rejects.toThrow('/export/apps.json')
  })
})
