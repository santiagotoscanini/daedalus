import { describe, expect, it } from 'vitest'
import {
  classifyRecords,
  isDebris,
  MANAGED,
  mailPosture,
  readableTarget,
  toRecord,
  type ZoneRecord,
  zoneDrift,
} from './dns-zone'

const DOMAIN = 'example.org'
const rec = (name: string, type: string, content: string, comment: string | null = null) =>
  toRecord(DOMAIN)({ name, type, content, comment })

const TUNNEL = 'abc123.cfargotunnel.com'

const zone: ZoneRecord[] = [
  rec('app.example.org', 'CNAME', TUNNEL, MANAGED),
  rec('s2.example.org', 'A', '203.0.113.7'),
  rec('example.org', 'CNAME', 'pages.example.net'),
  rec('example.org', 'MX', 'mx1.mail.example'),
  rec('example.org', 'TXT', '"v=spf1 include:_spf.mail.example ~all"'),
  rec('_dmarc.example.org', 'TXT', 'v=DMARC1; p=quarantine'),
  rec('s1._domainkey.example.org', 'CNAME', 'dkim.mail.example'),
  rec('_acme-challenge.example.org', 'TXT', 'token'),
  rec('www.example.org', 'CNAME', 'pages.example.net'),
  rec('www.example.org', 'CNAME', 'pages.example.net'),
]

describe('toRecord', () => {
  it('names the apex @ and strips the quotes Cloudflare sometimes keeps on TXT', () => {
    const r = rec('example.org', 'TXT', '"v=spf1 -all"')
    expect(r.short).toBe('@')
    expect(r.content).toBe('v=spf1 -all')
  })
})

describe('classifyRecords', () => {
  const g = classifyRecords(zone, new Set(['app.example.org']))

  it('puts the tunnel CNAMEs and the A record under the house', () => {
    expect(g.names.map((n) => [n.short, n.away, n.atHome, n.managed])).toEqual([
      ['app', 'tunnel', true, true],
      ['s2', 'wan', false, false],
    ])
  })

  it('claims MX and TXT at a mail domain, but not its other records', () => {
    expect(g.mail).toHaveLength(1)
    expect(g.mail[0]?.records.map((r) => `${r.short} ${r.type}`)).toEqual([
      '@ MX',
      '_dmarc TXT',
      '@ TXT',
      's1._domainkey CNAME',
    ])
    expect(g.elsewhere.map((r) => `${r.short} ${r.type}`)).toEqual(['@ CNAME'])
  })

  it('files acme challenges and exact duplicates as leftovers, and leaves nothing unclassified', () => {
    expect(g.leftovers.map((r) => r.short)).toEqual(['_acme-challenge', 'www', 'www'])
    expect(g.unclassified).toEqual([])
  })
})

describe('isDebris', () => {
  it('is false for a record that appears once', () => {
    expect(isDebris(rec('a.example.org', 'A', '1.2.3.4'), zone)).toBe(false)
  })
})

describe('mailPosture', () => {
  it('reads the SPF qualifier, the DKIM selector count and the DMARC policy', () => {
    const m = mailPosture(DOMAIN, zone)
    expect(m.mx).toEqual(['mx1.mail.example'])
    expect(m.spf).toEqual({ include: ['_spf.mail.example'], qualifier: '~' })
    expect(m.dkim).toBe(1)
    expect(m.dmarc).toEqual({ policy: 'quarantine' })
  })
})

describe('zoneDrift', () => {
  it('reports each of the three disagreements', () => {
    const lan = [
      { host: 'app.example.org', ip: '10.0.0.2' },
      { host: 'db.example.org', ip: '10.0.0.2' },
      { host: 'pc.example.org', ip: '10.0.0.9' },
    ]
    expect(
      zoneDrift({
        published: new Set(['app.example.org', 'new.example.org']),
        lan,
        lanSet: new Set(lan.map((h) => h.host)),
        served: new Set(['app.example.org']),
        tunnel: new Set(['app.example.org', 'old.example.org']),
        box: '10.0.0.2',
      }),
    ).toEqual({
      publishedWithoutLan: ['new.example.org'],
      lanWithoutRoute: ['db.example.org'],
      tunnelWithoutApp: ['old.example.org'],
    })
  })

  it('claims nothing about routes when traefik did not answer', () => {
    expect(
      zoneDrift({
        published: new Set(),
        lan: [{ host: 'db.example.org', ip: '10.0.0.2' }],
        lanSet: new Set(['db.example.org']),
        served: null,
        tunnel: new Set(),
        box: '10.0.0.2',
      }).lanWithoutRoute,
    ).toEqual([])
  })
})

describe('readableTarget', () => {
  it('names the tunnel instead of printing its id', () => {
    expect(readableTarget(TUNNEL)).toBe('the tunnel')
    expect(readableTarget('pages.example.net')).toBe('pages.example.net')
  })
})
