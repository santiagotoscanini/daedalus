import { describe, expect, it } from 'vitest'
import {
  appRepo,
  defaultImage,
  registryHostPattern,
  type Site,
  siteFrom,
  stripBaseDomain,
  UNBOUND_SITE,
} from './site'

const SITE: Site = {
  baseDomain: 'box.test',
  owner: 'octo',
  registryHost: 'registry.box.test',
  grafanaUrl: 'https://grafana.box.test',
}

describe('siteFrom', () => {
  it('reads as missing when nothing is bound — never as some particular box', () => {
    expect(siteFrom({})).toEqual({
      baseDomain: 'localhost',
      owner: 'unknown-owner',
      registryHost: 'registry.localhost',
      grafanaUrl: 'https://grafana.localhost',
    })
    expect(UNBOUND_SITE).toEqual(siteFrom({}))
  })

  it('derives the two hosts from the domain that WAS bound', () => {
    expect(siteFrom({ baseDomain: 'box.test', owner: 'octo' })).toEqual(SITE)
  })

  it('keeps a bound host over the derived one', () => {
    const s = siteFrom({
      baseDomain: 'box.test',
      registryHost: 'zot.elsewhere.test',
      grafanaUrl: 'https://graphs.elsewhere.test',
    })
    expect(s.registryHost).toBe('zot.elsewhere.test')
    expect(s.grafanaUrl).toBe('https://graphs.elsewhere.test')
  })

  it('reads an empty binding as an absent one', () => {
    // nix renders `NAME=` for a value it does not have.
    expect(siteFrom({ baseDomain: '', owner: '', registryHost: '', grafanaUrl: '' })).toEqual(
      UNBOUND_SITE,
    )
  })
})

describe('the helpers', () => {
  it('spells the platform-default image from the registry host', () => {
    expect(defaultImage(SITE, 'iris')).toBe('registry.box.test/iris:latest')
  })

  it('spells a registry app’s repository from the owner', () => {
    expect(appRepo(SITE, 'iris')).toBe('octo/iris')
  })

  it('escapes the registry host for a RegExp, so a dot matches a dot', () => {
    const re = new RegExp(`^${registryHostPattern(SITE)}/`)
    expect(re.test('registry.box.test/iris')).toBe(true)
    expect(re.test('registryXboxXtest/iris')).toBe(false)
  })

  it('strips the base domain and only the base domain', () => {
    expect(stripBaseDomain(SITE, 'films.box.test')).toBe('films')
    expect(stripBaseDomain(SITE, 'films.example.com')).toBe('films.example.com')
    expect(stripBaseDomain(SITE, 'box.test')).toBe('box.test')
    expect(stripBaseDomain(SITE, 'filmsbox.test')).toBe('filmsbox.test')
  })

  it('answers for the site it is handed, not for one read at import', () => {
    const other = siteFrom({ baseDomain: 'other.test' })
    expect(defaultImage(other, 'iris')).toBe('registry.other.test/iris:latest')
    expect(stripBaseDomain(other, 'films.box.test')).toBe('films.box.test')
  })
})
