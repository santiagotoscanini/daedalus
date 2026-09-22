import { describe, expect, it } from 'vitest'
import {
  type ExternalApp,
  type ExternalAppInput,
  externalAppError,
  externalAppFrom,
  externalAppId,
  isExternalAppList,
} from './external-apps'

// The guard is what stands between a stored `apps.external` row and a
// component: a row it accepts renders, a row it rejects degrades to no rows.
// The validator is what stands between the form and the store.

const ROW: ExternalApp = {
  id: 'docs-example-org',
  name: 'docs',
  host: 'docs.example.org',
  platform: 'GitHub Pages',
  description: 'The manual.',
  repo: 'octo/docs',
}

const INPUT: ExternalAppInput = {
  name: 'docs',
  host: 'docs.example.org',
  platform: 'GitHub Pages',
  description: 'The manual.',
  repo: 'octo/docs',
}

describe('isExternalAppList', () => {
  it('accepts a stored row and an empty list', () => {
    expect(isExternalAppList([ROW])).toBe(true)
    expect(isExternalAppList([])).toBe(true)
  })

  it('rejects a platform this build does not know', () => {
    expect(isExternalAppList([{ ...ROW, platform: 'Netlify' }])).toBe(false)
  })

  it('rejects a missing host and a non-string repo', () => {
    const { host: _host, ...noHost } = ROW
    expect(isExternalAppList([noHost])).toBe(false)
    expect(isExternalAppList([{ ...ROW, repo: 42 }])).toBe(false)
  })

  it('rejects anything that is not a list of objects', () => {
    expect(isExternalAppList(null)).toBe(false)
    expect(isExternalAppList({})).toBe(false)
    expect(isExternalAppList(['docs'])).toBe(false)
  })
})

describe('externalAppId', () => {
  it('files a host under a slug that a bare app name cannot spell', () => {
    expect(externalAppId('Docs.Example.org')).toBe('docs-example-org')
    expect(externalAppId(' example.org ')).toBe('example-org')
  })
})

describe('externalAppError', () => {
  it('accepts a complete row, with or without a repo', () => {
    expect(externalAppError(INPUT, [])).toBeNull()
    expect(externalAppError({ ...INPUT, repo: null }, [])).toBeNull()
  })

  it('requires a name, a description and a public-looking host', () => {
    expect(externalAppError({ ...INPUT, name: ' ' }, [])).toMatch(/name/)
    expect(externalAppError({ ...INPUT, description: '' }, [])).toMatch(/description/)
    expect(externalAppError({ ...INPUT, host: 'docs' }, [])).toMatch(/two labels/)
    expect(externalAppError({ ...INPUT, host: 'docs_.example.org' }, [])).toMatch(/hostname/)
  })

  it('holds the repo to owner/name', () => {
    expect(externalAppError({ ...INPUT, repo: 'docs' }, [])).toMatch(/owner\/name/)
    expect(externalAppError({ ...INPUT, repo: 'https://github.com/octo/docs' }, [])).toMatch(
      /owner\/name/,
    )
  })

  it('refuses a host already listed, and an id a registry app holds', () => {
    expect(externalAppError(INPUT, ['docs-example-org'])).toMatch(/already listed/)
    expect(externalAppError(INPUT, ['docs'])).toBeNull()
  })
})

describe('externalAppFrom', () => {
  it('trims, lower-cases the host, and files the row under its id', () => {
    expect(
      externalAppFrom({ ...INPUT, name: ' docs ', host: 'Docs.Example.org', repo: '  ' }),
    ).toEqual({ ...ROW, repo: null })
  })
})
