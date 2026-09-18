import { describe, expect, it } from 'vitest'
import { appSecretFile, appSecretKeys, isSecretKey, secretKeyError } from './secret-keys'

// The charset is the wall in front of `sops set`'s index argument on the host,
// so what is pinned here is what a NAME may be — not formatting taste. The
// same rule is written three times by design (browser, server function, host
// agent); these tests are the one place it is stated as a list of cases, and
// stacks/daedalus/host/secret-set.sh's `case` must agree with them.

describe('secretKeyError', () => {
  it('accepts the names an environment variable actually has', () => {
    for (const key of ['INVITE_CODE', 'A', '_LEADING', 'X9', 'a_lower_one', '_']) {
      expect(secretKeyError(key)).toBeNull()
    }
  })

  it('refuses anything that is not one, naming the rule and never the value', () => {
    for (const key of [
      '9LEADING_DIGIT',
      'HAS-HYPHEN',
      'HAS SPACE',
      'HAS.DOT',
      'HAS/SLASH',
      'HAS"QUOTE',
      "HAS'QUOTE",
      'HAS]BRACKET',
      'HAS\nNEWLINE',
      'HAS$DOLLAR',
      'HAS\\BACKSLASH',
      'é',
    ]) {
      expect(secretKeyError(key), key).not.toBeNull()
    }
  })

  it('refuses an empty name, and anything that is not a string', () => {
    expect(secretKeyError('')).toBe('no variable name was given')
    expect(secretKeyError(undefined)).not.toBeNull()
    expect(secretKeyError(null)).not.toBeNull()
    expect(secretKeyError(42)).not.toBeNull()
    expect(secretKeyError({ toString: () => 'OK' })).not.toBeNull()
  })

  it('bounds the length, so a name cannot become a payload', () => {
    expect(secretKeyError('A'.repeat(64))).toBeNull()
    expect(secretKeyError('A'.repeat(65))).not.toBeNull()
  })

  it("refuses sops's own dotenv rows, which are metadata and not variables", () => {
    // Setting one of these would rewrite the file's MAC or its recipient list
    // rather than add a secret — and listing one would show the operator a
    // "variable" they can neither have set nor use.
    for (const key of ['sops_mac', 'sops_version', 'sops_age__list_0__map_enc']) {
      expect(secretKeyError(key), key).not.toBeNull()
    }
    // Only that exact prefix, and case-sensitively: SOPS_TOKEN is a name an
    // app may legitimately want.
    expect(secretKeyError('SOPS_TOKEN')).toBeNull()
  })
})

describe('isSecretKey', () => {
  it('is the predicate form of the same rule', () => {
    expect(isSecretKey('INVITE_CODE')).toBe(true)
    expect(isSecretKey('has-hyphen')).toBe(false)
    expect(isSecretKey(7)).toBe(false)
  })
})

describe('appSecretKeys', () => {
  // A real sops dotenv, trimmed: the names are plain and the values are not,
  // which is the asymmetry the whole write-only editor stands on.
  const FILE = [
    'OIDC_EMAILS=ENC[AES256_GCM,data:vCy/vPnA8G4o,iv:MWHSRAOQ,tag:5ptc6Gf,type:str]',
    'INVITE_CODE=ENC[AES256_GCM,data:JoR5Ces85,iv:Fuk0YwM3,tag:QsgKaU0,type:str]',
    'sops_age__list_0__map_enc=-----BEGIN AGE ENCRYPTED FILE-----\\nYWdl',
    'sops_age__list_0__map_recipient=age13xjamkkjcc2wdan3c8tscslqulgwz9uv',
    'sops_lastmodified=2026-08-21T14:13:00Z',
    'sops_mac=ENC[AES256_GCM,data:abc,iv:def,tag:ghi,type:str]',
    'sops_unencrypted_suffix=_unencrypted',
    'sops_version=3.12.1',
    '',
  ].join('\n')

  it('is the app variables, in file order, without sops bookkeeping', () => {
    expect(appSecretKeys(FILE)).toEqual(['OIDC_EMAILS', 'INVITE_CODE'])
  })

  it('carries no value anywhere in its output', () => {
    expect(appSecretKeys(FILE).join(' ')).not.toContain('ENC[')
  })

  it('is empty for an empty file and for one with only metadata', () => {
    expect(appSecretKeys('')).toEqual([])
    expect(appSecretKeys('sops_version=3.12.1\n')).toEqual([])
  })

  it('drops a line whose name this editor could not send back', () => {
    // Not hypothetical tidiness: the list is rendered as the set of keys with
    // a Replace and a Remove button, and a name the server function would
    // refuse must not get one.
    expect(appSecretKeys('OK=ENC[x]\nnot a name=ENC[y]\n=ENC[z]\nBARE\n')).toEqual(['OK'])
  })
})

describe('appSecretFile', () => {
  it('is the path site/.sops.yaml’s creation rule matches', () => {
    // `^vault/(apps/)?[a-z0-9-]+\.sops$`, resolved relative to the site
    // directory — which is why the container passes exactly this string as
    // --filename-override rather than an absolute path.
    expect(appSecretFile('hermes')).toBe('vault/apps/hermes-env.sops')
    expect(appSecretFile('hermes')).toMatch(/^vault\/(apps\/)?[a-z0-9-]+\.sops$/)
  })
})
