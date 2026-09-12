import { describe, expect, it } from 'vitest'
import {
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
