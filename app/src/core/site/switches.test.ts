import { describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../ctx'

vi.mock('./index', () => ({
  siteEdit: vi.fn(async () => ({
    committed: { modules: { enabled: {}, web: {} } },
    desired: {
      modules: { enabled: { metube: false }, web: { pihole: { label: 'dns', public: null } } },
    },
  })),
  saveSiteEdit: vi.fn(async () => undefined),
}))

import { saveSiteEdit } from './index'
import { moduleSwitches, setModuleEnabled, setModuleWeb } from './switches'

const exports: Record<string, unknown> = {
  'modules.json': { n8n: true, metube: true, traefik: true, tv: true, pihole: true },
  'switches.json': { structural: ['traefik', 'pihole'], stacks: { tv: ['jellyfin', 'sonarr'] } },
  'publishing.json': {
    webApps: {
      n8n: { hostname: 'n8n.example', serviceName: 'n8n', aliases: [], exposeRemotely: true },
      jellyfin: { hostname: 'tv.example', serviceName: 'jellyfin', aliases: ['jf.example'] },
      // Dials a URL: no serviceName to match, found by its name.
      pihole: { hostname: 'pihole.example', serviceName: null, serviceUrl: 'http://x' },
      ha: { hostname: 'ha.example', serviceName: null, serviceUrl: 'http://x' },
      hermes: { hostname: 'hermes.example', serviceName: 'app-hermes' },
    },
    takenHostnames: [
      'n8n.example',
      'tv.example',
      'jf.example',
      'pihole.example',
      'ha.example',
      'hermes.example',
    ],
  },
  'images.json': { pins: { n8n: {}, metube: {}, jellyfin: {}, sonarr: {} } },
}

const ctx = {
  exportPath: (f: string) => f,
  site: { baseDomain: 'example' },
  snapshot: async ({
    path,
    decoder,
    fallback,
  }: {
    path: string
    decoder: (v: unknown, p: string) => unknown
    fallback: unknown
  }) => {
    const raw = exports[path]
    return raw === undefined
      ? { data: fallback, available: false }
      : { data: decoder(raw, ''), available: true }
  },
} as unknown as Ctx

describe('the switches', () => {
  it('names what each stack takes with it', async () => {
    const rows = await moduleSwitches(ctx)
    expect(rows.map((r) => r.id)).toEqual(['metube', 'n8n', 'pihole', 'traefik', 'tv'])
    const n8n = rows.find((r) => r.id === 'n8n')
    expect(n8n).toMatchObject({
      running: true,
      desired: true,
      switched: false,
      structural: false,
      containers: ['n8n'],
      hostnames: ['n8n.example'],
      web: [
        {
          name: 'n8n',
          hostname: 'n8n.example',
          label: 'n8n',
          public: true,
          aliases: [],
          committed: { label: null, public: null },
          desired: { label: null, public: null },
        },
      ],
    })
    // A multi-container stack: its members from the log registry, the
    // hostnames of every member, no container of the stack's own name.
    expect(rows.find((r) => r.id === 'tv')).toMatchObject({
      containers: ['jellyfin', 'sonarr'],
      hostnames: ['tv.example', 'jf.example'],
    })
    // A webApp with no serviceName is the module's by name, and carries the
    // document's word about it.
    expect(rows.find((r) => r.id === 'pihole')?.web).toEqual([
      {
        name: 'pihole',
        hostname: 'pihole.example',
        label: 'pihole',
        public: false,
        aliases: [],
        committed: { label: null, public: null },
        desired: { label: 'dns', public: null },
      },
    ])
    // A registry app's webApp belongs to no module.
    expect(rows.flatMap((r) => r.web.map((w) => w.name))).not.toContain('hermes')
    expect(rows.find((r) => r.id === 'metube')).toMatchObject({ desired: false, switched: true })
    expect(rows.find((r) => r.id === 'traefik')?.structural).toBe(true)
  })

  it('refuses the structural and the unknown, writes the rest', async () => {
    expect(await setModuleEnabled(ctx, 'traefik', false)).toEqual({
      ok: false,
      reason: 'traefik stays on: every published hostname rides it',
    })
    expect((await setModuleEnabled(ctx, 'nope', false)).ok).toBe(false)
    expect(await setModuleEnabled(ctx, 'n8n', false)).toEqual({ ok: true })
    expect(saveSiteEdit).toHaveBeenLastCalledWith(ctx, {
      'modules.enabled': { metube: false, n8n: false },
    })
    // Back to what the host says, with the document silent on it: the key goes.
    await setModuleEnabled(ctx, 'metube', true)
    expect(saveSiteEdit).toHaveBeenLastCalledWith(ctx, { 'modules.enabled': {} })
  })

  it('moves a hostname, and refuses what the box could not publish', async () => {
    expect((await setModuleWeb(ctx, 'nope', 'nope', { label: 'x' })).ok).toBe(false)
    expect((await setModuleWeb(ctx, 'n8n', 'jellyfin', { label: 'x' })).ok).toBe(false)
    // Taken by something else on the box.
    expect((await setModuleWeb(ctx, 'n8n', 'n8n', { label: 'tv' })).ok).toBe(false)
    // A label that is not one: the hostname rules say why.
    expect((await setModuleWeb(ctx, 'n8n', 'n8n', { label: 'a.b' })).ok).toBe(false)
    // Its own current name is never a collision, and puts the field back.
    expect(await setModuleWeb(ctx, 'n8n', 'n8n', { label: 'N8N' })).toEqual({ ok: true })
    expect(saveSiteEdit).toHaveBeenLastCalledWith(ctx, {
      'modules.web': { pihole: { label: 'dns', public: null } },
    })
    expect(await setModuleWeb(ctx, 'n8n', 'n8n', { label: 'flows', public: false })).toEqual({
      ok: true,
    })
    expect(saveSiteEdit).toHaveBeenLastCalledWith(ctx, {
      'modules.web': {
        pihole: { label: 'dns', public: null },
        n8n: { label: 'flows', public: false },
      },
    })
    // Exposure back to what the box has, with the document silent: null again;
    // a structural module's hostname may still move.
    expect(await setModuleWeb(ctx, 'pihole', 'pihole', { label: null })).toEqual({ ok: true })
    expect(saveSiteEdit).toHaveBeenLastCalledWith(ctx, { 'modules.web': {} })
  })
})
