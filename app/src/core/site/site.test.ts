import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeSiteDocument } from '../../lib/contract/domains/site-doc'
import { renderSiteFile, type SiteDocument, type SiteGithubApp } from './file'
import { changesBetween, getField } from './index'

// The renderer and the decoder are two halves of one contract: what one
// writes the other must read back unchanged, or the Site tab reports a
// committed file as "differs" forever and every Apply rewrites it.

const doc: SiteDocument = {
  schemaVersion: 1,
  identity: {
    hostname: 'box',
    baseDomain: 'example.test',
    controlPlane: 'ctl',
    controlPlanePrevious: null,
    timezone: 'UTC',
    owner: 'o',
    operator: { user: 'u', group: 'g' },
  },
  network: {
    lanIp: '10.0.0.2',
    interface: 'eth0',
    gateway: '10.0.0.1',
    wanHost: 'box.example.test',
    ddns: { host: 'box.example.test', interval: '300s' },
    dhcp: {
      active: true,
      router: '10.0.0.1',
      start: '10.0.0.100',
      end: '10.0.0.200',
      leaseTime: '8h',
    },
    dnsUpstreams: ['1.1.1.1'],
  },
  mail: { sender: 's@example.test', alertTo: 'a@example.test' },
  cloudflare: { accountId: 'acc', zoneId: 'zone', tunnelId: 'tun' },
}

const APP: SiteGithubApp = {
  id: 123456,
  slug: 'box-daedalus',
  clientId: 'Iv23liExampleClient',
  htmlUrl: 'https://github.com/apps/box-daedalus',
  owner: 'o',
  ownerId: 42,
}

const reRender = (bytes: string): string => renderSiteFile(decodeSiteDocument(JSON.parse(bytes)))

describe('site.json round trip', () => {
  it('render → parse → decode → render is a fixed point', () => {
    const once = renderSiteFile(doc)
    const back = decodeSiteDocument(JSON.parse(once))
    expect(renderSiteFile(back)).toBe(once)
    // The decoder names the absent App; the renderer leaves it out again.
    expect(back).toEqual({ ...doc, github: { app: null } })
  })

  it('ignores the preamble keys and refuses a wrong type', () => {
    const parsed = JSON.parse(renderSiteFile(doc)) as Record<string, unknown>
    expect(parsed._generated).toBeTypeOf('string')
    expect(() => decodeSiteDocument({ ...parsed, mail: { sender: 1, alertTo: 'x' } })).toThrow(
      /mail\.sender/,
    )
  })

  it('reads a site.json from before the control plane was part of it', () => {
    const parsed = JSON.parse(renderSiteFile(doc)) as { identity: Record<string, unknown> }
    delete parsed.identity.controlPlane
    delete parsed.identity.controlPlanePrevious
    const back = decodeSiteDocument(parsed)
    expect(back.identity.controlPlane).toBe('')
    expect(back.identity.controlPlanePrevious).toBeNull()
  })

  it('re-renders a file from before the control plane and the App to its own bytes', () => {
    const { _generated, _why } = JSON.parse(renderSiteFile(doc)) as Record<string, string>
    const legacy = {
      _generated,
      _why,
      schemaVersion: 1,
      identity: {
        hostname: 'box',
        baseDomain: 'example.test',
        timezone: 'UTC',
        owner: 'o',
        operator: { user: 'u', group: 'g' },
      },
      network: doc.network,
      mail: doc.mail,
      cloudflare: doc.cloudflare,
    }
    const bytes = `${JSON.stringify(legacy, null, 2)}\n`
    expect(reRender(bytes)).toBe(bytes)
  })

  // A real committed site.json, when the runner is given one
  // (REAL_SITE_JSON=<path>). Reading it and writing it back must not move a byte.
  it.runIf(process.env.REAL_SITE_JSON !== undefined)(
    're-renders a real committed site.json byte for byte',
    () => {
      const bytes = readFileSync(process.env.REAL_SITE_JSON as string, 'utf8')
      expect(reRender(bytes)).toBe(bytes)
    },
  )
})

describe('the github block', () => {
  const withApp: SiteDocument = { ...doc, github: { app: APP } }

  it('round-trips byte for byte, as the last key', () => {
    const bytes = renderSiteFile(withApp)
    expect(reRender(bytes)).toBe(bytes)
    expect(decodeSiteDocument(JSON.parse(bytes))).toEqual(withApp)
    const parsed = JSON.parse(bytes) as { github: { app: Record<string, unknown> } }
    expect(Object.keys(parsed).at(-1)).toBe('github')
    expect(Object.keys(parsed.github.app)).toEqual([
      'id',
      'slug',
      'clientId',
      'htmlUrl',
      'owner',
      'ownerId',
    ])
  })

  it('is left out without an App, so an older file keeps its bytes', () => {
    expect(renderSiteFile({ ...doc, github: { app: null } })).toBe(renderSiteFile(doc))
    expect(renderSiteFile(doc)).not.toContain('"github"')
  })

  it('writes only the identifiers, whatever else the object carries', () => {
    const reply = {
      pem: '-----BEGIN RSA PRIVATE KEY-----',
      webhook_secret: 'hook',
      ownerId: APP.ownerId,
      owner: APP.owner,
      htmlUrl: APP.htmlUrl,
      clientId: APP.clientId,
      slug: APP.slug,
      id: APP.id,
    }
    const bytes = renderSiteFile({ ...doc, github: { app: reply as unknown as SiteGithubApp } })
    expect(bytes).not.toContain('PRIVATE KEY')
    expect(bytes).not.toContain('webhook_secret')
    expect(bytes).toBe(renderSiteFile(withApp))
  })

  it('refuses an App whose id is not a number', () => {
    const parsed = JSON.parse(renderSiteFile(withApp)) as { github: { app: { id: unknown } } }
    parsed.github.app.id = '123456'
    expect(() => decodeSiteDocument(parsed)).toThrow(/github\.app\.id/)
  })
})

describe('changesBetween', () => {
  it('names the editable fields that differ, in document order', () => {
    const edited = structuredClone(doc)
    edited.network.wanHost = 'other.example.test'
    edited.mail.alertTo = 'b@example.test'
    edited.network.dnsUpstreams = ['1.1.1.1', '9.9.9.9']
    expect(changesBetween(doc, edited)).toEqual([
      'network.wanHost',
      'network.dnsUpstreams',
      'mail.alertTo',
    ])
  })

  it('reports the timezone and the zone, which nix sources from site.json', () => {
    const edited = structuredClone(doc)
    edited.identity.timezone = 'Europe/Oslo'
    edited.identity.baseDomain = 'other.test'
    edited.cloudflare.zoneId = 'zone-2'
    expect(changesBetween(doc, edited)).toEqual([
      'identity.baseDomain',
      'identity.timezone',
      'cloudflare.zoneId',
    ])
  })

  it('reports a rename as the label and the address kept serving beside it', () => {
    const edited = structuredClone(doc)
    edited.identity.controlPlane = 'admin'
    edited.identity.controlPlanePrevious = 'ctl'
    expect(changesBetween(doc, edited)).toEqual([
      'identity.controlPlane',
      'identity.controlPlanePrevious',
    ])
  })

  it('does not report a field nix does not source from site.json', () => {
    const edited = structuredClone(doc)
    edited.identity.hostname = 'renamed'
    expect(changesBetween(doc, edited)).toEqual([])
    expect(getField(edited, 'network.lanIp')).toBe('10.0.0.2')
  })

  it('reports nothing pending for a github block the committed file already holds', () => {
    const committed = decodeSiteDocument(
      JSON.parse(renderSiteFile({ ...doc, github: { app: APP } })),
    )
    expect(changesBetween(committed, structuredClone(committed))).toEqual([])
  })
})
