import { describe, expect, it } from 'vitest'
import {
  appNameError,
  effectiveHostname,
  hostnameError,
  isAppName,
  type ReservedLabels,
} from './hostname'
import { siteFrom } from './site'

const BASE_DOMAIN = 'box.test'
const SITE = siteFrom({ baseDomain: BASE_DOMAIN })
// As /export/publishing.json carries them: the engine's `hooks`, and one a host
// publishes outside the box.
const RESERVED: ReservedLabels = {
  hooks: 'is reserved for the GitHub App’s webhook.',
  daedalus: 'is the project’s public landing page, a record this box does not own.',
}

describe('isAppName', () => {
  it('takes every name on this box', () => {
    // site/apps.json as of this change, plus `daedalus` — hand-declared in
    // nix rather than in the registry, and an app name all the same. The four
    // private copies of this rule accepted more than creation ever did, so the
    // stricter one had to be checked against the names already live.
    for (const n of ['anansi', 'argus', 'chismed', 'daedalus', 'hermes', 'iris', 'plutus', 'voyra'])
      expect(isAppName(n)).toBe(true)
  })

  it('refuses what the four copies used to accept', () => {
    // `/^[a-z0-9][a-z0-9-]{0,62}$/` took both of these; creation never did.
    expect(isAppName('abc-')).toBe(false)
    expect(isAppName('a'.repeat(63))).toBe(false)
    expect(isAppName('a'.repeat(59))).toBe(true)
  })

  it('refuses anything that is not a string, and does not normalise', () => {
    for (const v of [undefined, null, 42, {}, ['iris'], '', ' iris ', 'Iris', 'a_b', '-a', 'a.b'])
      expect(isAppName(v)).toBe(false)
  })

  it('agrees with the creation validator on shape and length', () => {
    // appNameError adds the reserved and taken lists; on everything else the
    // two must not be able to disagree, which is what a divergence was.
    for (const n of ['iris', 'app-2', 'a', 'abc-', 'a'.repeat(59), 'a'.repeat(60), 'a_b', '-a'])
      expect(isAppName(n)).toBe(appNameError(n) === null)
  })
})

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
    expect(hostnameError(SITE, '')).toBeNull()
    expect(hostnameError(SITE, '   ')).toBeNull()
  })

  it('accepts one label under the base domain', () => {
    expect(hostnameError(SITE, `films.${BASE_DOMAIN}`)).toBeNull()
  })

  it('rejects a taken hostname', () => {
    const h = `films.${BASE_DOMAIN}`
    expect(hostnameError(SITE, h, [h])).toContain('already published')
  })

  it('rejects foreign domains', () => {
    expect(hostnameError(SITE, 'films.example.com')).toContain(`must end in .${BASE_DOMAIN}`)
  })

  it('rejects the bare domain — it does not end in .<domain>', () => {
    expect(hostnameError(SITE, BASE_DOMAIN)).toContain(`must end in .${BASE_DOMAIN}`)
  })

  it('rejects an empty label in front of the domain', () => {
    expect(hostnameError(SITE, `.${BASE_DOMAIN}`)).toContain('needs a name in front')
  })

  it('rejects a second level — the wildcard cert matches one label', () => {
    expect(hostnameError(SITE, `a.b.${BASE_DOMAIN}`)).toContain('only one level')
  })

  it('rejects bad label characters', () => {
    expect(hostnameError(SITE, `a_b.${BASE_DOMAIN}`)).toContain('lowercase letters')
  })
})

describe('effectiveHostname', () => {
  it('prefers the override', () => {
    expect(effectiveHostname(SITE, 'anansi', `films.${BASE_DOMAIN}`)).toBe(`films.${BASE_DOMAIN}`)
  })

  it('derives the default from the name', () => {
    expect(effectiveHostname(SITE, 'anansi', null)).toBe(`anansi.${BASE_DOMAIN}`)
  })
})

// The reserved labels are the one collision `taken` cannot catch: a record the
// box does not publish at all never appears in its own hostname list, and
// route-sync would reconcile it away. They come from the export, so a label
// is reserved exactly where the box says so.
describe('reserved labels', () => {
  for (const label of Object.keys(RESERVED)) {
    it(`refuses ${label} as a hostname`, () => {
      expect(hostnameError(SITE, `${label}.${BASE_DOMAIN}`, [], RESERVED)).toContain(label)
    })

    it(`refuses ${label} as an app name, because the name derives the hostname`, () => {
      expect(appNameError(label, [], RESERVED)).toContain(label)
    })
  }

  it('still allows a name that merely contains a reserved label', () => {
    expect(hostnameError(SITE, `daedalus-app.${BASE_DOMAIN}`, [], RESERVED)).toBeNull()
    expect(appNameError('daedalus-app', [], RESERVED)).toBeNull()
  })

  it('reserves nothing a box does not', () => {
    expect(hostnameError(SITE, `daedalus.${BASE_DOMAIN}`)).toBeNull()
    expect(appNameError('daedalus')).toBeNull()
  })

  it('is not fooled by a name an object already has', () => {
    expect(appNameError('constructor', [], RESERVED)).toBeNull()
    expect(hostnameError(SITE, `constructor.${BASE_DOMAIN}`, [], RESERVED)).toBeNull()
  })
})
