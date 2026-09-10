import { describe, expect, it } from 'vitest'
import { decodeSiteDocument } from '../../lib/contract/domains/site-doc'
import { renderSiteFile, type SiteDocument } from './file'
import { changesBetween, getField } from './index'

// The renderer and the decoder are two halves of one contract: what one
// writes the other must read back unchanged, or the Site tab reports a
// committed file as "differs" forever and every Apply rewrites it.

const doc: SiteDocument = {
  schemaVersion: 1,
  identity: {
    hostname: 'box',
    baseDomain: 'example.test',
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

describe('site.json round trip', () => {
  it('render → parse → decode → render is a fixed point', () => {
    const once = renderSiteFile(doc)
    const back = decodeSiteDocument(JSON.parse(once))
    expect(renderSiteFile(back)).toBe(once)
    expect(back).toEqual(doc)
  })

  it('ignores the preamble keys and refuses a wrong type', () => {
    const parsed = JSON.parse(renderSiteFile(doc)) as Record<string, unknown>
    expect(parsed._generated).toBeTypeOf('string')
    expect(() => decodeSiteDocument({ ...parsed, mail: { sender: 1, alertTo: 'x' } })).toThrow(
      /mail\.sender/,
    )
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

  it('does not report a field nix does not source from site.json', () => {
    const edited = structuredClone(doc)
    edited.identity.hostname = 'renamed'
    expect(changesBetween(doc, edited)).toEqual([])
    expect(getField(edited, 'network.lanIp')).toBe('10.0.0.2')
  })
})
