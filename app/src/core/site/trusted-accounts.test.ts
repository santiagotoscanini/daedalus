import { describe, expect, it } from 'vitest'
import { trustChangeWords } from '../../lib/module-switch'
import type { SiteGithubApp } from './file'
import { trustedAccountsError } from './trusted-accounts'

const APP: SiteGithubApp = {
  id: 1,
  slug: 'daedalus-box',
  clientId: 'Iv1',
  htmlUrl: 'https://github.com/apps/daedalus-box',
  owner: 'me',
  ownerId: 42,
}

describe('trustedAccountsError', () => {
  it('accepts a list of distinct accounts other than the owner', () => {
    expect(
      trustedAccountsError(
        [
          { login: 'santree-ai', id: 296_897_829 },
          { login: 'x', id: 7 },
        ],
        APP,
      ),
    ).toBeNull()
    expect(trustedAccountsError([], null)).toBeNull()
  })

  it.each([
    ['not a list', 'santree-ai', /list/],
    ['a login with shell in it', [{ login: 'a;rm', id: 1 }], /login/],
    ['a login with a newline', [{ login: 'a\nb', id: 1 }], /login/],
    ['a non-integer id', [{ login: 'a', id: 1.5 }], /whole number/],
    ['the owner', [{ login: 'me', id: 42 }], /owns the App/],
    [
      'the same id twice',
      [
        { login: 'a', id: 3 },
        { login: 'b', id: 3 },
      ],
      /twice/,
    ],
  ])('refuses %s', (_label, value, message) => {
    expect(trustedAccountsError(value, APP)).toMatch(message)
  })
})

describe('trustChangeWords', () => {
  it('names who is trusted and who is let go, by id', () => {
    expect(
      trustChangeWords(
        [
          { login: 'old', id: 1 },
          { login: 'kept', id: 2 },
        ],
        [
          { login: 'kept-renamed', id: 2 },
          { login: 'santree-ai', id: 3 },
        ],
      ),
    ).toEqual(['github: santree-ai trusted', 'github: old untrusted'])
  })
})
