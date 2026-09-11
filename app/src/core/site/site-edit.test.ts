import { createHash } from 'node:crypto'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RepoFacts } from '../../lib/contract/domains/repo'
import type { Ctx } from '../ctx'
import { renderSiteFile, type SiteDocument } from './file'
import { renderSiteFiles, saveSiteEdit, siteEdit, siteState } from './index'

// The GitHub block rides every path that renders site.json: the edit the
// Settings tabs and the Apply bar read (siteEdit, whose render.after is what
// lib/apply-flow sends), a saved edit, the Site tab's Write (renderSiteFiles),
// and its in-sync digest (siteState). No settings tab knows the block, so each
// of these must carry it from the committed file. A path that dropped it would
// commit a site.json without the App, and the next rebuild would lose it.

const h = vi.hoisted(() => ({
  // What the running system says, via BoxSettings: the same box, no App.
  box: {
    general: {
      hostname: 'box',
      baseDomain: 'example.test',
      controlPlane: { label: 'ctl', previousLabel: null },
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
      dns: { upstreams: ['1.1.1.1'] },
    },
    integrations: {
      mail: { sender: 's@example.test', alertTo: 'a@example.test' },
      cloudflare: { accountId: 'acc', zoneId: 'zone', tunnelId: 'tun' },
    },
  },
}))

vi.mock('../settings', () => ({ readBoxSettings: async () => h.box }))
vi.mock('../../lib/repo/settings', () => ({
  SETTING_KEYS: { siteCommit: 'site.commit', siteDraft: 'site.draft' },
}))

const committed: SiteDocument = {
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
  github: {
    app: {
      id: 123456,
      slug: 'box-daedalus',
      clientId: 'Iv23liExampleClient',
      htmlUrl: 'https://github.com/apps/box-daedalus',
      owner: 'o',
      ownerId: 42,
    },
  },
}

const COMMITTED_BYTES = renderSiteFile(committed)

/** The preferences store, as JSON in memory. Postgres stores it as jsonb, which
    keeps the values but not the key order, so the key order must come from
    the committed base. */
function fakeCtx(): { ctx: Ctx; store: Map<string, unknown> } {
  const store = new Map<string, unknown>()
  const ctx = {
    store: {
      read: async <T>(key: string, guard: (v: unknown) => v is T): Promise<T | undefined> => {
        const v = store.get(key)
        return v !== undefined && guard(v) ? v : undefined
      },
      write: async (key: string, value: unknown): Promise<void> => {
        store.set(key, JSON.parse(JSON.stringify(value)))
      },
      delete: async (key: string): Promise<void> => {
        store.delete(key)
      },
    },
  } as unknown as Ctx
  return { ctx, store }
}

let dir = ''

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'site-edit-'))
  writeFileSync(join(dir, 'site.json'), COMMITTED_BYTES)
  vi.stubEnv('SITE_PATH', dir)
})

afterAll(() => {
  vi.unstubAllEnvs()
  rmSync(dir, { recursive: true, force: true })
})

describe('the github block through the site edit paths', () => {
  it('is in the desired document, with nothing pending and the bytes unchanged', async () => {
    const { ctx } = fakeCtx()
    const edit = await siteEdit(ctx)
    expect(edit.desired.github).toEqual(committed.github)
    expect(edit.changes).toEqual([])
    expect(edit.render.before).toBe(COMMITTED_BYTES)
    expect(edit.render.after).toBe(COMMITTED_BYTES)
  })

  it('survives a saved edit, in the Apply render and in the Write', async () => {
    const { ctx } = fakeCtx()
    const edit = await saveSiteEdit(ctx, { 'mail.alertTo': 'b@example.test' })
    const expected = renderSiteFile({
      ...committed,
      mail: { ...committed.mail, alertTo: 'b@example.test' },
    })
    expect(edit.changes).toEqual(['mail.alertTo'])
    expect(edit.desired.github).toEqual(committed.github)
    expect(edit.render.after).toBe(expected)
    expect((await renderSiteFiles(ctx))['site.json']).toBe(expected)
  })

  it('comes from the committed file, never from a stored draft', async () => {
    const { ctx, store } = fakeCtx()
    // A draft saved before the App existed: its github block is stale.
    store.set('site.draft', {
      ...committed,
      mail: { ...committed.mail, alertTo: 'b@example.test' },
      github: { app: null },
    })
    const edit = await siteEdit(ctx)
    expect(edit.changes).toEqual(['mail.alertTo'])
    expect(edit.desired.github).toEqual(committed.github)
    expect(edit.render.after).toContain('"slug": "box-daedalus"')
  })

  it('leaves the Site tab reporting a committed file with an App as current', async () => {
    const { ctx } = fakeCtx()
    const sha256 = createHash('sha256').update(COMMITTED_BYTES, 'utf8').digest('hex')
    const facts = {
      site: {
        path: '/site',
        exists: true,
        toplevel: '/repo',
        inThisRepo: true,
        files: {
          'site.json': { status: 'clean', sha256 },
          'apps.json': { status: 'clean', sha256: null },
        },
      },
    } as unknown as RepoFacts
    const state = await siteState(ctx, facts)
    expect(state.files[0]).toEqual({ name: 'site.json', status: 'clean', current: true })
  })
})
