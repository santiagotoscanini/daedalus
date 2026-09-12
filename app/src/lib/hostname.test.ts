import { describe, expect, it } from 'vitest'
import {
  appNameError,
  BASE_DOMAIN,
  effectiveHostname,
  hostnameError,
  RESERVED_LABELS,
} from './hostname'

describe('appNameError', () => {
  it('accepts a plain label', () => {
    expect(appNameError('anansi')).toBeNull()
    expect(appNameError('a')).toBeNull()
    expect(appNameError('app-2')).toBeNull()
  })

  it('normalises before judging', () => {
    expect(appNameError('  Voyra  ')).toBeNull()
  })

  it('rejects empty input with the picker prompt', () => {
    expect(appNameError('')).toBe('pick a repository first.')
    expect(appNameError('   ')).toBe('pick a repository first.')
  })

  it('rejects a taken name, case-insensitively', () => {
    expect(appNameError('Anansi', ['anansi'])).toContain('already an app')
  })

  it('rejects anything that is not a DNS label', () => {
    expect(appNameError('a_b')).toContain('lowercase letters, digits and inner hyphens')
    expect(appNameError('-a')).toContain('lowercase letters, digits and inner hyphens')
    expect(appNameError('a-')).toContain('lowercase letters, digits and inner hyphens')
    expect(appNameError('a.b')).toContain('lowercase letters, digits and inner hyphens')
  })

  it('caps the length so app-<name> fits a 63-char DNS label', () => {
    expect(appNameError('a'.repeat(59))).toBeNull()
    expect(appNameError('a'.repeat(60))).toContain('too long')
  })
})

describe('hostnameError', () => {
  it('treats empty as "use the default"', () => {
    expect(hostnameError('')).toBeNull()
    expect(hostnameError('   ')).toBeNull()
  })

  it('accepts one label under the base domain', () => {
    expect(hostnameError(`films.${BASE_DOMAIN}`)).toBeNull()
  })

  it('rejects a taken hostname', () => {
    const h = `films.${BASE_DOMAIN}`
    expect(hostnameError(h, [h])).toContain('already published')
  })

  it('rejects foreign domains', () => {
    expect(hostnameError('films.example.com')).toContain(`must end in .${BASE_DOMAIN}`)
  })

  it('rejects the bare domain — it does not end in .<domain>', () => {
    expect(hostnameError(BASE_DOMAIN)).toContain(`must end in .${BASE_DOMAIN}`)
  })

  it('rejects an empty label in front of the domain', () => {
    expect(hostnameError(`.${BASE_DOMAIN}`)).toContain('needs a name in front')
  })

  it('rejects a second level — the wildcard cert matches one label', () => {
    expect(hostnameError(`a.b.${BASE_DOMAIN}`)).toContain('only one level')
  })

  it('rejects bad label characters', () => {
    expect(hostnameError(`a_b.${BASE_DOMAIN}`)).toContain('lowercase letters')
  })
})

describe('effectiveHostname', () => {
  it('prefers the override', () => {
    expect(effectiveHostname('anansi', `films.${BASE_DOMAIN}`)).toBe(`films.${BASE_DOMAIN}`)
  })

  it('derives the default from the name', () => {
    expect(effectiveHostname('anansi', null)).toBe(`anansi.${BASE_DOMAIN}`)
  })
})

// The reserved labels are the one collision `taken` cannot catch: `daedalus`
// is a GitHub Pages record this box does not publish at all, so it never
// appears in the box's own hostname list, and route-sync would reconcile it
// away. Before this rule both validators returned null for it.
describe('reserved labels', () => {
  for (const label of Object.keys(RESERVED_LABELS)) {
    it(`refuses ${label} as a hostname`, () => {
      expect(hostnameError(`${label}.${BASE_DOMAIN}`)).toContain(label)
    })

    it(`refuses ${label} as an app name, because the name derives the hostname`, () => {
      expect(appNameError(label)).toContain(label)
    })
  }

  it('still allows a name that merely contains a reserved label', () => {
    expect(hostnameError(`daedalus-app.${BASE_DOMAIN}`)).toBeNull()
    expect(appNameError('daedalus-app')).toBeNull()
  })
})
