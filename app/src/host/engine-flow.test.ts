import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EngineUpdateOutcome } from './engine-flow'

// What this request makes the host do is the reason to test it: fast-forward
// the engine clone this very process runs out of, move the configuration's
// lock, commit, `nixos-rebuild switch`, and revert if the control plane does
// not come back. So the assertions are about what is NOT written: a request
// while the host is mid-run, a second caller racing the first, or one arriving
// under an engine override must leave engine-request.json exactly as it was.
// The bridge is real, pointed at a temp APPLY_DIR (host/bridge.test.ts's
// archetype); site.json is a temp SITE_PATH.
//
// `pending` and `chain` are module-scoped with no reset hook, so every test
// takes a FRESH module: `vi.resetModules()` then `await import`.

let dir: string
let site: string
const previous: Record<string, string | undefined> = {}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engine-flow-'))
  site = await mkdtemp(join(tmpdir(), 'engine-site-'))
  previous.APPLY_DIR = process.env.APPLY_DIR
  previous.SITE_PATH = process.env.SITE_PATH
  process.env.APPLY_DIR = dir
  process.env.SITE_PATH = site
})

afterEach(async () => {
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(dir, { recursive: true, force: true })
  await rm(site, { recursive: true, force: true })
})

async function flow() {
  vi.resetModules()
  return import('./engine-flow')
}

/** `finishedAt` is rewritten at every phase, so a live run's is recent. */
const hostStatus = (status: Record<string, unknown>) =>
  writeFile(
    join(dir, 'engine-status.json'),
    JSON.stringify({ finishedAt: new Date().toISOString(), ...status }),
    'utf8',
  )

/** The smallest site.json the reader accepts, with the developer block as given. */
const committedSite = (developer?: { engineOverride: string | null }) =>
  writeFile(
    join(site, 'site.json'),
    JSON.stringify({
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
        interface: null,
        gateway: null,
        wanHost: 'box.example.test',
        ddns: { host: 'box.example.test', interval: '300s' },
        dhcp: { active: false, router: '', start: '', end: '', leaseTime: '8h' },
        dnsUpstreams: [],
      },
      mail: { sender: 's@example.test', alertTo: 'a@example.test' },
      cloudflare: { accountId: '', zoneId: '', tunnelId: '' },
      ...(developer === undefined ? {} : { developer }),
    }),
    'utf8',
  )

const REQUEST = 'engine-request.json'

function idOf(outcome: EngineUpdateOutcome): string {
  if (!outcome.ok) throw new Error(`expected an update, got ${outcome.code}: ${outcome.reason}`)
  return outcome.id
}

describe('an update with nothing in the way', () => {
  it('publishes a request carrying only the actor', async () => {
    await committedSite()
    const { runEngineUpdate } = await flow()
    const outcome = await runEngineUpdate({ actor: 'op@example.test' })
    expect(await readdir(dir)).toEqual([REQUEST])
    const request = JSON.parse(await readFile(join(dir, REQUEST), 'utf8')) as Record<
      string,
      unknown
    >
    expect(request.id).toBe(idOf(outcome))
    expect(request.actor).toBe('op@example.test')
    expect(Object.keys(request).sort()).toEqual(['actor', 'id', 'requestedAt'])
  })

  it('needs no site.json to exist', async () => {
    // A box before its first write has no override either.
    const { runEngineUpdate } = await flow()
    expect((await runEngineUpdate({ actor: 'op' })).ok).toBe(true)
  })
})

describe('an engine override', () => {
  it('is refused before anything is written, naming the clone', async () => {
    await committedSite({ engineOverride: '/srv/engine' })
    const { runEngineUpdate } = await flow()
    expect(await runEngineUpdate({ actor: 'op' })).toEqual({
      ok: false,
      code: 'refused',
      reason:
        'clear the engine override first — the running system is built from /srv/engine, not from the pinned engine',
    })
    expect(await readdir(dir)).toEqual([])
  })

  it('cleared is no override', async () => {
    await committedSite({ engineOverride: null })
    const { runEngineUpdate } = await flow()
    expect((await runEngineUpdate({ actor: 'op' })).ok).toBe(true)
  })
})

describe('an update the host is already running', () => {
  it('is refused, and does not replace the request it is reading', async () => {
    await hostStatus({ id: 'abc', state: 'running', phase: 'building' })
    const { runEngineUpdate } = await flow()
    expect(await runEngineUpdate({ actor: 'op' })).toEqual({
      ok: false,
      code: 'busy',
      reason: 'an engine update is already running (building)',
    })
    expect(await readdir(dir)).toEqual(['engine-status.json'])
  })
})

describe('two callers at once', () => {
  it('publish exactly one request', async () => {
    const { runEngineUpdate } = await flow()
    const [a, b] = await Promise.all([
      runEngineUpdate({ actor: 'one' }),
      runEngineUpdate({ actor: 'two' }),
    ])
    const applied = [a, b].filter((o) => o.ok)
    expect([a, b].filter((o) => !o.ok)).toEqual([
      {
        ok: false,
        code: 'busy',
        reason: 'the previous engine update request has not been picked up by the host yet',
      },
    ])
    expect(applied).toHaveLength(1)
    expect(await readdir(dir)).toEqual([REQUEST])
  })
})
