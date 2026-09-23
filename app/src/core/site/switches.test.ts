import { describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../ctx'

vi.mock('./index', () => ({
  siteEdit: vi.fn(async () => ({
    committed: { modules: { enabled: {} } },
    desired: { modules: { enabled: { metube: false } } },
  })),
  saveSiteEdit: vi.fn(async () => undefined),
}))

import { saveSiteEdit } from './index'
import { moduleSwitches, setModuleEnabled } from './switches'

const exports: Record<string, unknown> = {
  'modules.json': { n8n: true, metube: true, traefik: true, tv: true },
  'switches.json': { structural: ['traefik'], stacks: { tv: ['jellyfin', 'sonarr'] } },
  'publishing.json': {
    webApps: {
      n8n: { hostname: 'n8n.example', serviceName: 'n8n', aliases: [] },
      jellyfin: { hostname: 'tv.example', serviceName: 'jellyfin', aliases: ['jf.example'] },
      pihole: { hostname: 'pihole.example', serviceName: 'pihole' },
      ha: { hostname: 'ha.example', serviceName: null, serviceUrl: 'http://x' },
    },
  },
  'images.json': { pins: { n8n: {}, metube: {}, jellyfin: {}, sonarr: {} } },
}

const ctx = {
  exportPath: (f: string) => f,
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
    expect(rows.map((r) => r.id)).toEqual(['metube', 'n8n', 'traefik', 'tv'])
    const n8n = rows.find((r) => r.id === 'n8n')
    expect(n8n).toMatchObject({
      running: true,
      desired: true,
      switched: false,
      structural: false,
      containers: ['n8n'],
      hostnames: ['n8n.example'],
    })
    // A multi-container stack: its members from the log registry, the
    // hostnames of every member, no container of the stack's own name.
    expect(rows.find((r) => r.id === 'tv')).toMatchObject({
      containers: ['jellyfin', 'sonarr'],
      hostnames: ['tv.example', 'jf.example'],
    })
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
})
