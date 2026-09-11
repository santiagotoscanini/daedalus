import { describe, expect, it } from 'vitest'
import { githubTokenKind, missingScopes, oauthClientId, readDeviceReply } from './github-signin'

describe('githubTokenKind', () => {
  it('reads the kind off the prefix, and admits when there is none', () => {
    expect(githubTokenKind('gho_abc')).toBe('oauth')
    expect(githubTokenKind('ghp_abc')).toBe('classic')
    expect(githubTokenKind('github_pat_abc')).toBe('fine-grained')
    expect(githubTokenKind('0123456789abcdef0123456789abcdef01234567')).toBe('unknown')
  })
})

describe('missingScopes', () => {
  it('names the asked-for scopes the header does not grant', () => {
    expect(missingScopes('repo, workflow')).toEqual([])
    expect(missingScopes('read:org,repo')).toEqual([])
    expect(missingScopes('public_repo')).toEqual(['repo'])
    expect(missingScopes(null)).toEqual(['repo'])
  })
})

describe('oauthClientId', () => {
  it('prefers a non-empty environment value', () => {
    expect(oauthClientId('Iv1.override')).toBe('Iv1.override')
    expect(oauthClientId('')).toBe(oauthClientId(undefined))
  })
})

describe('readDeviceReply', () => {
  it('hands over the token once there is one', () => {
    expect(readDeviceReply({ access_token: 'gho_x' }, 5)).toEqual({ kind: 'token', token: 'gho_x' })
  })

  it('keeps waiting while the code is outstanding, slower when told to', () => {
    expect(readDeviceReply({ error: 'authorization_pending' }, 5)).toEqual({
      kind: 'wait',
      interval: 5,
    })
    expect(readDeviceReply({ error: 'slow_down' }, 5)).toEqual({ kind: 'wait', interval: 10 })
    expect(readDeviceReply({ error: 'slow_down', interval: 15 }, 5)).toEqual({
      kind: 'wait',
      interval: 15,
    })
  })

  it('stops on every terminal answer, and on one it does not know', () => {
    for (const error of [
      'expired_token',
      'access_denied',
      'device_flow_disabled',
      'incorrect_client_credentials',
      'something_new',
    ]) {
      expect(readDeviceReply({ error }, 5).kind).toBe('stop')
    }
    expect(readDeviceReply({}, 5).kind).toBe('stop')
  })
})
