import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { decodeSiteDocument } from '../../host/contract/domains/site-doc'
import { changesBetween, getField } from './'
import { renderSiteFile, type SiteDocument, type SiteGithubApp } from './file'

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
  developer: { engineOverride: null },
  commits: { author: 'box' },
  modules: { enabled: {}, web: {}, players: {} },
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
  it('carries the break-glass login switch, and leaves it out when it was never written', () => {
    // A field nix does not read: absent stays absent, so a file from
    // before the switch re-renders to its own bytes; present, it survives
    // the round trip the next write is.
    expect(renderSiteFile(doc)).not.toContain('localLogin')
    const on = renderSiteFile({ ...doc, auth: { localLogin: true } })
    expect(on).toContain('"localLogin": true')
    expect(decodeSiteDocument(JSON.parse(on)).auth).toEqual({ localLogin: true })
    expect(reRender(on)).toBe(on)
    expect(decodeSiteDocument(JSON.parse(renderSiteFile(doc))).auth).toBeUndefined()
  })

  it('carries the engine override, and leaves the block out while it is off', () => {
    // Another field nix does not read — the host agents do. Off (null) and
    // absent are the same document, so a file from before the block, and one
    // whose override was cleared, both render without it; set, it survives
    // the round trip and sits before the github block.
    expect(renderSiteFile(doc)).not.toContain('developer')
    const on = renderSiteFile({ ...doc, developer: { engineOverride: '/srv/engine' } })
    expect(on).toContain('"engineOverride": "/srv/engine"')
    expect(decodeSiteDocument(JSON.parse(on)).developer).toEqual({ engineOverride: '/srv/engine' })
    expect(reRender(on)).toBe(on)
    expect(decodeSiteDocument(JSON.parse(renderSiteFile(doc))).developer).toEqual({
      engineOverride: null,
    })
    const withApp = renderSiteFile({
      ...doc,
      developer: { engineOverride: '/srv/engine' },
      github: { app: APP },
    })
    expect(withApp.indexOf('"developer"')).toBeLessThan(withApp.indexOf('"github"'))
  })

  it('carries the switches and the moved hostnames, and only what was moved', () => {
    // A webApp with both fields null is the host's word and leaves the file;
    // a null field inside a written entry is left out of it. Both blocks
    // absent is no modules block at all, so an older file keeps its bytes.
    expect(renderSiteFile(doc)).not.toContain('modules')
    const moved = renderSiteFile({
      ...doc,
      modules: {
        enabled: { n8n: false },
        web: {
          grocy: { label: 'pantry', public: null },
          gatus: { label: null, public: null },
          metube: { label: null, public: true },
        },
        players: {},
      },
    })
    expect(moved).toContain('"n8n": false')
    expect(moved).toContain('"grocy": {\n        "label": "pantry"\n      }')
    expect(moved).not.toContain('gatus')
    expect(moved).toContain('"metube": {\n        "public": true\n      }')
    expect(reRender(moved)).toBe(moved)
    expect(decodeSiteDocument(JSON.parse(moved)).modules).toEqual({
      enabled: { n8n: false },
      web: { grocy: { label: 'pantry', public: null }, metube: { label: null, public: true } },
      players: {},
    })
    // The web block alone is a modules block too.
    const webOnly = renderSiteFile({
      ...doc,
      modules: { enabled: {}, web: { grocy: { label: 'pantry', public: false } }, players: {} },
    })
    expect(webOnly).toContain('"modules"')
    expect(webOnly).not.toContain('"enabled"')
  })

  it('writes a roster sorted by name, and drops an empty one', () => {
    const bob = { name: 'bob_', uuid: '00000000-0000-4000-8000-000000000002', op: false }
    const alice = { name: 'Alice', uuid: '00000000-0000-4000-8000-000000000001', op: true }
    const rostered = renderSiteFile({
      ...doc,
      modules: { enabled: {}, web: {}, players: { minecraft: [bob, alice], factorio: [] } },
    })
    expect(rostered).not.toContain('factorio')
    expect(rostered.indexOf('"Alice"')).toBeLessThan(rostered.indexOf('"bob_"'))
    expect(reRender(rostered)).toBe(rostered)
    expect(decodeSiteDocument(JSON.parse(rostered)).modules.players).toEqual({
      minecraft: [alice, bob],
    })
    // An entry written without `op` reads as not op.
    const bare = JSON.parse(rostered)
    delete bare.modules.players.minecraft[1].op
    expect(decodeSiteDocument(bare).modules.players.minecraft?.[1]?.op).toBe(false)
  })

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

  it('reports the engine override, which the host agents read at Apply time', () => {
    const edited = structuredClone(doc)
    edited.developer.engineOverride = '/srv/engine'
    expect(changesBetween(doc, edited)).toEqual(['developer.engineOverride'])
  })

  it('carries the commit identity, and leaves the block out at the default', () => {
    // A choice between the identities nix configured, never a name: the file
    // holds `box` or `operator`, and `box` is the same document as none.
    expect(renderSiteFile(doc)).not.toContain('commits')
    const operator = renderSiteFile({ ...doc, commits: { author: 'operator' } })
    expect(operator).toContain('"author": "operator"')
    expect(decodeSiteDocument(JSON.parse(operator)).commits).toEqual({ author: 'operator' })
    expect(decodeSiteDocument(JSON.parse(renderSiteFile(doc))).commits).toEqual({ author: 'box' })
    expect(() =>
      decodeSiteDocument({ ...JSON.parse(operator), commits: { author: 'someone' } }),
    ).toThrow()
    const edited = structuredClone(doc)
    edited.commits.author = 'operator'
    expect(changesBetween(doc, edited)).toEqual(['commits.author'])
  })

  it('reports nothing pending for a github block the committed file already holds', () => {
    const committed = decodeSiteDocument(
      JSON.parse(renderSiteFile({ ...doc, github: { app: APP } })),
    )
    expect(changesBetween(committed, structuredClone(committed))).toEqual([])
  })
})
