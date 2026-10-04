import { describe, expect, it } from 'vitest'
import {
  boxBuildRefusal,
  ENV_ENTRIES_MAX,
  envEntryError,
  envMapError,
  validateBuildSettings,
} from './build-settings'

describe('validateBuildSettings', () => {
  it('accepts every field with a valid value', () => {
    expect(
      validateBuildSettings({
        app: 'iris',
        buildOnBox: true,
        buildStrategy: 'dockerfile',
        buildPublish: 'candidate',
        railpackEnv: { RAILPACK_NODE_PLAYWRIGHT_INSTALL: 'true' },
      }),
    ).toEqual({
      app: 'iris',
      patch: {
        buildOnBox: true,
        buildStrategy: 'dockerfile',
        buildPublish: 'candidate',
        railpackEnv: { RAILPACK_NODE_PLAYWRIGHT_INSTALL: 'true' },
      },
    })
  })

  it('refuses the enums outside their sets', () => {
    expect(() => validateBuildSettings({ app: 'iris', buildStrategy: 'nixpacks' })).toThrow(
      'auto | railpack | dockerfile',
    )
    expect(() => validateBuildSettings({ app: 'iris', buildPublish: 'draft' })).toThrow(
      'live | candidate',
    )
    expect(() => validateBuildSettings({ app: 'iris', buildOnBox: 'yes' })).toThrow('true or false')
  })

  it('refuses a bad app name, an unknown key and an empty patch', () => {
    expect(() => validateBuildSettings({ app: '../x', buildOnBox: true })).toThrow('app name')
    expect(() => validateBuildSettings({ app: 'iris', stage: 'live' })).toThrow(
      'stage is not a build setting',
    )
    expect(() => validateBuildSettings({ app: 'iris', buildEnvPlaceholders: { A: 'x' } })).toThrow(
      'buildEnvPlaceholders is not a build setting',
    )
    expect(() => validateBuildSettings({ app: 'iris' })).toThrow('nothing to change')
    expect(() => validateBuildSettings(null)).toThrow('expected build settings')
  })

  it('holds Railpack keys to RAILPACK_*', () => {
    expect(() =>
      validateBuildSettings({ app: 'iris', railpackEnv: { NODE_VERSION: '24' } }),
    ).toThrow('RAILPACK_')
    expect(() => validateBuildSettings({ app: 'iris', railpackEnv: { RAILPACK_: '1' } })).toThrow(
      'not a valid name',
    )
    expect(() =>
      validateBuildSettings({ app: 'iris', railpackEnv: { RAILPACK_PRUNE_DEPS: 7 } }),
    ).toThrow('must be a string')
    expect(() => validateBuildSettings({ app: 'iris', railpackEnv: ['A'] })).toThrow(
      'object of names',
    )
  })

  it('passes on only the known Railpack switches, and never a command', () => {
    for (const cmd of ['RAILPACK_START_CMD', 'RAILPACK_BUILD_CMD', 'RAILPACK_INSTALL_CMD']) {
      expect(envEntryError(cmd, 'node x.mjs')).toContain("repo's railpack.json")
    }
    for (const other of [
      'RAILPACK_CONFIG_FILE',
      'RAILPACK_PACKAGES',
      'RAILPACK_NODE_NPM_INSTALL',
    ]) {
      expect(envEntryError(other, 'x')).toContain('not a Railpack switch')
    }
    for (const [k, v] of [
      ['RAILPACK_PRUNE_DEPS', 'true'],
      ['RAILPACK_NODE_PLAYWRIGHT_INSTALL', '1'],
      ['RAILPACK_DISABLE_CACHES', '*'],
      ['RAILPACK_NO_SPA', 'false'],
      ['RAILPACK_SPA_OUTPUT_DIR', 'dist/client'],
      ['RAILPACK_NODE_VERSION', '24.18.1'],
      ['RAILPACK_BUILD_APT_PACKAGES', 'git'],
      ['RAILPACK_DEPLOY_APT_PACKAGES', 'ffmpeg chromium fonts-liberation'],
    ] as const) {
      expect(envEntryError(k, v)).toBeNull()
    }
  })

  it('holds each Railpack switch to the values Railpack reads', () => {
    expect(envEntryError('RAILPACK_PRUNE_DEPS', 'yes')).toContain('true, false, 1 or 0')
    for (const dir of ['../etc', 'dist/../..', '/etc', 'dist dir']) {
      expect(envEntryError('RAILPACK_SPA_OUTPUT_DIR', dir)).toContain('inside the repo')
    }
    expect(envEntryError('RAILPACK_NODE_VERSION', 'path:/tmp/node')).toContain('Node version')
    for (const list of ['ffmpeg; curl x|sh', 'ffmpeg  git', 'ffmpeg,git', '$(id)']) {
      expect(envEntryError('RAILPACK_DEPLOY_APT_PACKAGES', list)).toContain('Debian')
    }
    expect(envEntryError(`RAILPACK_${'A'.repeat(56)}`, '1')).toContain('not a valid name')
  })

  it("refuses Build on this box for an app name with a '-', and only that", () => {
    expect(() => validateBuildSettings({ app: 'my-app', buildOnBox: true })).toThrow(
      "containing '-'",
    )
    expect(validateBuildSettings({ app: 'my-app', buildOnBox: false }).patch).toEqual({
      buildOnBox: false,
    })
    expect(validateBuildSettings({ app: 'my-app', buildStrategy: 'railpack' }).patch).toEqual({
      buildStrategy: 'railpack',
    })
    expect(boxBuildRefusal('iris')).toBeNull()
    expect(boxBuildRefusal('my-app')).toContain('Rename the app')
  })

  it('caps values at 512 characters, entries at 40, and refuses line breaks', () => {
    const caches = (n: number) => Array.from({ length: n }, () => 'a').join(' ')
    expect(envEntryError('RAILPACK_DISABLE_CACHES', caches(256))).toBeNull()
    expect(envEntryError('RAILPACK_DISABLE_CACHES', `${caches(256)} a`)).toContain('512')
    expect(envEntryError('RAILPACK_PRUNE_DEPS', 'true\nX=2')).toContain('line break')
    const many = Array.from({ length: ENV_ENTRIES_MAX + 1 }, (_, i): [string, string] => [
      `RAILPACK_K${String(i)}`,
      'v',
    ])
    expect(envMapError(many)).toContain('At most 40')
    expect(
      envMapError([
        ['RAILPACK_PRUNE_DEPS', '1'],
        ['RAILPACK_PRUNE_DEPS', '0'],
      ]),
    ).toContain('twice')
  })
})
