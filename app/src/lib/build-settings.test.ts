import { describe, expect, it } from 'vitest'
import {
  boxBuildRefusal,
  buildEnvSizeError,
  ENV_ENTRIES_MAX,
  envEntryError,
  envMapError,
  validateBuildSettings,
} from './build-settings'
import { buildEnvBytes } from './builds'

describe('validateBuildSettings', () => {
  it('accepts every field with a valid value', () => {
    expect(
      validateBuildSettings({
        app: 'iris',
        buildOnBox: true,
        buildStrategy: 'dockerfile',
        buildPublish: 'candidate',
        buildEnvPlaceholders: { VITE_PUBLIC_KEY: 'placeholder', _X: '' },
        railpackEnv: { RAILPACK_NODE_PLAYWRIGHT_INSTALL: 'true' },
      }),
    ).toEqual({
      app: 'iris',
      patch: {
        buildOnBox: true,
        buildStrategy: 'dockerfile',
        buildPublish: 'candidate',
        buildEnvPlaceholders: { VITE_PUBLIC_KEY: 'placeholder', _X: '' },
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
    expect(() => validateBuildSettings({ app: 'iris' })).toThrow('nothing to change')
    expect(() => validateBuildSettings(null)).toThrow('expected build settings')
  })

  it('holds placeholder names to the env-name shape', () => {
    expect(() =>
      validateBuildSettings({ app: 'iris', buildEnvPlaceholders: { 'lower-case': 'x' } }),
    ).toThrow('not a valid name')
    expect(() =>
      validateBuildSettings({ app: 'iris', buildEnvPlaceholders: { '1ST': 'x' } }),
    ).toThrow('not a valid name')
    expect(() =>
      validateBuildSettings({ app: 'iris', buildEnvPlaceholders: { [`A${'B'.repeat(64)}`]: 'x' } }),
    ).toThrow('not a valid name')
    expect(() => validateBuildSettings({ app: 'iris', buildEnvPlaceholders: { A: 7 } })).toThrow(
      'must be a string',
    )
    expect(() => validateBuildSettings({ app: 'iris', buildEnvPlaceholders: ['A'] })).toThrow(
      'object of names',
    )
  })

  it('holds Railpack keys to RAILPACK_*', () => {
    expect(() =>
      validateBuildSettings({ app: 'iris', railpackEnv: { NODE_VERSION: '24' } }),
    ).toThrow('RAILPACK_')
    expect(() => validateBuildSettings({ app: 'iris', railpackEnv: { RAILPACK_: '1' } })).toThrow(
      'not a valid name',
    )
  })

  it('refuses the names the builder reserves, as the host does, and the package-manager prefixes', () => {
    for (const name of [
      'PATH',
      'HOME',
      'GITHUB_TOKEN',
      'NODE_OPTIONS',
      'DAEDALUS_TOKEN_FILE',
      'LD_PRELOAD',
      'GIT_SSH_COMMAND',
      'MISE_DATA_DIR',
      'RAILPACK_PRUNE_DEPS',
      'NPM_CONFIG_REGISTRY',
      'PNPM_HOME',
      'COREPACK_NPM_REGISTRY',
      'YARN_NPM_REGISTRY_SERVER',
      'BUN_CONFIG_REGISTRY',
      'NODE_ENV',
      'GLIBC_TUNABLES',
      'GOPROXY',
      'PIP_INDEX_URL',
      'PYTHONPATH',
      'CARGO_HOME',
      'RUSTC_WRAPPER',
      'BUNDLE_GEMFILE',
      'PERL5OPT',
      'JAVA_TOOL_OPTIONS',
    ]) {
      expect(envEntryError('placeholders', name, 'x')).toContain(`${name} is reserved`)
    }
    for (const name of [
      'DATABASE_URL',
      'AUTH_SECRET',
      'PATHS',
      'NPM_TOKEN',
      'VITE_NODE_URL',
      'GOOGLE_MAPS_API_KEY',
    ]) {
      expect(envEntryError('placeholders', name, 'x')).toBeNull()
    }
    expect(() =>
      validateBuildSettings({ app: 'iris', buildEnvPlaceholders: { NPM_CONFIG_REGISTRY: 'x' } }),
    ).toThrow('buildEnvPlaceholders: NPM_CONFIG_REGISTRY is reserved')
  })

  it('passes on only the known Railpack switches, and never a command', () => {
    for (const cmd of ['RAILPACK_START_CMD', 'RAILPACK_BUILD_CMD', 'RAILPACK_INSTALL_CMD']) {
      expect(envEntryError('railpack', cmd, 'node x.mjs')).toContain("repo's railpack.json")
    }
    for (const other of [
      'RAILPACK_CONFIG_FILE',
      'RAILPACK_PACKAGES',
      'RAILPACK_NODE_NPM_INSTALL',
    ]) {
      expect(envEntryError('railpack', other, 'x')).toContain('not a Railpack switch')
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
      expect(envEntryError('railpack', k, v)).toBeNull()
    }
  })

  it('holds each Railpack switch to the values Railpack reads', () => {
    expect(envEntryError('railpack', 'RAILPACK_PRUNE_DEPS', 'yes')).toContain('true, false, 1 or 0')
    for (const dir of ['../etc', 'dist/../..', '/etc', 'dist dir']) {
      expect(envEntryError('railpack', 'RAILPACK_SPA_OUTPUT_DIR', dir)).toContain('inside the repo')
    }
    expect(envEntryError('railpack', 'RAILPACK_NODE_VERSION', 'path:/tmp/node')).toContain(
      'Node version',
    )
    for (const list of ['ffmpeg; curl x|sh', 'ffmpeg  git', 'ffmpeg,git', '$(id)']) {
      expect(envEntryError('railpack', 'RAILPACK_DEPLOY_APT_PACKAGES', list)).toContain('Debian')
    }
    expect(envEntryError('railpack', `RAILPACK_${'A'.repeat(56)}`, '1')).toContain(
      'not a valid name',
    )
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

  it('caps both maps together at 32 KiB, measured as the request carries them', () => {
    const big = (n: number, ch: string) =>
      Object.fromEntries(Array.from({ length: n }, (_, i) => [`K${String(i)}`, ch.repeat(512)]))
    // 40 values of 512 ASCII characters fit; the same in three-byte characters do not.
    expect(buildEnvSizeError(big(40, 'x'), {})).toBeNull()
    expect(buildEnvSizeError(big(40, '€'), {})).toContain('at most 32.0 KiB')
    expect(() =>
      validateBuildSettings({ app: 'iris', buildEnvPlaceholders: big(40, '€') }),
    ).toThrow('at most 32.0 KiB')
    // Each half fits alone; together they do not.
    expect(buildEnvSizeError(big(15, '€'), {})).toBeNull()
    expect(buildEnvSizeError(big(15, '€'), big(15, '€'))).not.toBeNull()
    const env = { placeholders: big(3, '€'), railpack: { RAILPACK_PRUNE_DEPS: 'true' } }
    expect(buildEnvBytes(env)).toBe(
      new TextEncoder().encode(JSON.stringify({ buildEnv: env }, null, 2)).length,
    )
  })

  it('caps values at 512 characters, entries at 40, and refuses line breaks', () => {
    expect(envEntryError('placeholders', 'A', 'x'.repeat(512))).toBeNull()
    expect(envEntryError('placeholders', 'A', 'x'.repeat(513))).toContain('512')
    expect(envEntryError('placeholders', 'A', 'a b-c')).toBeNull()
    expect(envEntryError('placeholders', 'A', 'one\nTWO=2')).toContain('line break')
    const many = Array.from({ length: ENV_ENTRIES_MAX + 1 }, (_, i): [string, string] => [
      `K${String(i)}`,
      'v',
    ])
    expect(envMapError('placeholders', many)).toContain('At most 40')
    expect(envMapError('placeholders', many.slice(0, ENV_ENTRIES_MAX))).toBeNull()
    expect(
      envMapError('placeholders', [
        ['A', '1'],
        ['A', '2'],
      ]),
    ).toContain('twice')
  })
})
