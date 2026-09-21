import { afterEach, describe, expect, it, vi } from 'vitest'
import { makeEnv } from './env'
import { readSite } from './site'

const REQUIRED = { DATABASE_URL: 'postgres://u@pg:5432/daedalus' }

const siteOf = (vars: Record<string, string | undefined>) =>
  readSite(
    makeEnv(
      () => ({ ...REQUIRED, ...vars }),
      () => {},
    ),
  )

describe('readSite', () => {
  it('reads the four bare names', () => {
    expect(
      siteOf({
        BASE_DOMAIN: 'box.test',
        GITHUB_OWNER: 'octo',
        REGISTRY_HOST: 'zot.box.test',
        GRAFANA_URL: 'https://graphs.box.test',
      }),
    ).toEqual({
      baseDomain: 'box.test',
      owner: 'octo',
      registryHost: 'zot.box.test',
      grafanaUrl: 'https://graphs.box.test',
    })
  })

  it('falls back to the VITE_ names a config bound before the rename', () => {
    expect(
      siteOf({
        VITE_BASE_DOMAIN: 'old.test',
        VITE_GITHUB_OWNER: 'old-owner',
        VITE_REGISTRY_HOST: 'registry.old.test',
        VITE_GRAFANA_URL: 'https://grafana.old.test',
      }),
    ).toEqual({
      baseDomain: 'old.test',
      owner: 'old-owner',
      registryHost: 'registry.old.test',
      grafanaUrl: 'https://grafana.old.test',
    })
  })

  it('prefers the bare name when both are bound, fact by fact', () => {
    const s = siteOf({
      BASE_DOMAIN: 'new.test',
      VITE_BASE_DOMAIN: 'old.test',
      VITE_GITHUB_OWNER: 'old-owner',
    })
    expect(s.baseDomain).toBe('new.test')
    expect(s.owner).toBe('old-owner')
    // Derived from the domain that won, not from the one that lost.
    expect(s.registryHost).toBe('registry.new.test')
  })

  it('reads an empty bare name as absent, so the old one still answers', () => {
    expect(siteOf({ BASE_DOMAIN: '', VITE_BASE_DOMAIN: 'old.test' }).baseDomain).toBe('old.test')
  })

  it('reads a malformed Grafana URL as unset rather than linking to it', () => {
    expect(siteOf({ BASE_DOMAIN: 'box.test', GRAFANA_URL: 'grafana.box.test' }).grafanaUrl).toBe(
      'https://grafana.box.test',
    )
  })

  it('looks missing when nothing is bound', () => {
    expect(siteOf({})).toEqual({
      baseDomain: 'localhost',
      owner: 'unknown-owner',
      registryHost: 'registry.localhost',
      grafanaUrl: 'https://grafana.localhost',
    })
  })

  describe('against the process', () => {
    afterEach(() => vi.unstubAllEnvs())

    it('reads at use: a value bound after import is the value returned', () => {
      vi.stubEnv('BASE_DOMAIN', 'first.test')
      expect(readSite().baseDomain).toBe('first.test')
      vi.stubEnv('BASE_DOMAIN', 'second.test')
      expect(readSite().baseDomain).toBe('second.test')
    })
  })
})
