import { describe, expect, it } from 'vitest'
import {
  ENV_NOTE_MAX,
  ENV_VALUE_MAX,
  envKeyError,
  envNoteError,
  envValueError,
  validateEnvVars,
} from './env-vars'

describe('a variable name', () => {
  it('is upper case, by convention', () => {
    expect(envKeyError('PUBLIC_SITE_URL', [], [])).toBeNull()
    expect(envKeyError('OFFLINE_FOR_NOW', [], [])).toBeNull()
    expect(envKeyError('lowercase', [], [])).toMatch(/upper case/)
    expect(envKeyError('Mixed_Case', [], [])).toMatch(/upper case/)
  })

  it('keeps the security rule it shares with secrets', () => {
    expect(envKeyError('WITH SPACE', [], [])).toMatch(/letter or underscore/)
    expect(envKeyError('QUOTE"', [], [])).toMatch(/letter or underscore/)
    expect(envKeyError('', [], [])).toMatch(/no variable name/)
    expect(envKeyError(42, [], [])).toMatch(/no variable name/)
  })

  it('is unique among the app’s variables', () => {
    expect(envKeyError('ENABLE_LIVE_PROBE', ['OFFLINE_FOR_NOW'], [])).toBeNull()
    expect(envKeyError('ENABLE_LIVE_PROBE', ['ENABLE_LIVE_PROBE'], [])).toMatch(
      /already a variable/,
    )
  })

  it('refuses a name the app holds as a secret, and says why', () => {
    const why = envKeyError('INVITE_CODE', [], ['INVITE_CODE', 'OIDC_EMAILS'])
    expect(why).toMatch(/is a secret of this app/)
    expect(why).toMatch(/in the clear/)
  })

  it('refuses a name the platform sets, naming the feature', () => {
    expect(envKeyError('DATABASE_URL', [], [])).toMatch(/set by the platform \(database\)/)
    expect(envKeyError('AUTH_SECRET', [], [])).toMatch(/set by the platform \(auth\)/)
    expect(envKeyError('LITELLM_BASE_URL', [], [])).toMatch(/set by the platform \(litellm\)/)
    expect(envKeyError('PORT', [], [])).toMatch(/set by the platform \(identity\)/)
  })

  it('refuses a name that comes from the image', () => {
    expect(envKeyError('PATH', [], [])).toMatch(/from the image or podman/)
    expect(envKeyError('NODE_ENV', [], [])).toMatch(/from the image or podman/)
  })

  it('allows an app’s own name that merely looks platform-ish', () => {
    // Not on either list: argus sets its own canonical origin rather than
    // using the APP_PUBLIC_URL the platform injects.
    expect(envKeyError('PUBLIC_SITE_URL', [], [])).toBeNull()
    expect(envKeyError('LITELLM_MODEL', [], [])).toBeNull()
  })
})

describe('a variable value', () => {
  it('is one line of bounded text', () => {
    expect(envValueError('true')).toBeNull()
    expect(envValueError('')).toBeNull()
    expect(envValueError('https://argus.toscanini.me')).toBeNull()
    expect(envValueError('two\nlines')).toMatch(/one line/)
    expect(envValueError('x'.repeat(ENV_VALUE_MAX + 1))).toMatch(/at most/)
    expect(envValueError(7)).toMatch(/must be text/)
  })
})

describe('a note', () => {
  it('is optional and bounded', () => {
    expect(envNoteError(null)).toBeNull()
    expect(envNoteError('')).toBeNull()
    expect(envNoteError('Maintenance brake, held off.')).toBeNull()
    expect(envNoteError('x'.repeat(ENV_NOTE_MAX + 1))).toMatch(/at most/)
  })
})

describe('the whole list', () => {
  it('reads argus’s four back unchanged', () => {
    const argus = [
      { key: 'ENABLE_LIVE_PROBE', value: 'true', note: 'ON: re-probe catalogued endpoints live.' },
      { key: 'ENABLE_LIVE_FRAME_PERSIST', value: 'true', note: null },
      { key: 'OFFLINE_FOR_NOW', value: 'false', note: 'Maintenance brake, held off.' },
      { key: 'PUBLIC_SITE_URL', value: 'https://argus.toscanini.me', note: null },
    ]
    expect(validateEnvVars(argus)).toEqual(argus)
  })

  it('names the offender and the rule', () => {
    expect(() => validateEnvVars([{ key: 'ok', value: 'x' }])).toThrow(/env\[0\]: .*upper case/)
    expect(() =>
      validateEnvVars([
        { key: 'A', value: 'x' },
        { key: 'A', value: 'y' },
      ]),
    ).toThrow(/env\[1\]: A is already a variable/)
    expect(() => validateEnvVars([{ key: 'A', value: 'a\nb' }])).toThrow(/A: a value is one line/)
  })

  it('treats an empty note as no note, and trims one that is there', () => {
    expect(validateEnvVars([{ key: 'A', value: 'x', note: '' }])[0]?.note).toBeNull()
    expect(validateEnvVars([{ key: 'A', value: 'x' }])[0]?.note).toBeNull()
    expect(validateEnvVars([{ key: 'A', value: 'x', note: '  why  ' }])[0]?.note).toBe('why')
  })

  it('refuses anything that is not a list of objects', () => {
    expect(() => validateEnvVars('nope')).toThrow(/must be an array/)
    expect(() => validateEnvVars([null])).toThrow(/env\[0\] must be an object/)
  })
})
