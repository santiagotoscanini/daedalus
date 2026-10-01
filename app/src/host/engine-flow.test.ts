import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../core/ctx'
import type { EngineUpdateOutcome } from './engine-flow'

// What this request makes the host do is the reason to test it: fast-forward
// the engine clone this very process runs out of, move the configuration's
// lock, commit, `nixos-rebuild switch`, and revert if the control plane does
// not come back. So the assertions are about what is NOT asked: a request
// while the host is mid-run, or one arriving under an engine override, must
// never reach the root helper. A fake Ctx's controller records the starts;
// the status file is real, in a temp VERBS_DIR, and site.json a temp
// SITE_PATH. A second caller racing the first is the helper's to refuse.
//
// `chain` is module-scoped with no reset hook, so every test takes a FRESH
// module: `vi.resetModules()` then `await import`.

let dir: string
let site: string
let started: unknown[][]
let answers: unknown[]
const previous: Record<string, string | undefined> = {}

const ctx = {
  controller: {
    rootFollow: async () => ({ run: { outcome: null, detail: '' } }),
    rootStart: async (...args: unknown[]) => {
      started.push(args)
      return (
        answers.shift() ?? {
          run: 'r1',
          verb: 'engine-update',
          outcome: null,
          detail: '',
          verbs: [],
        }
      )
    },
  },
} as unknown as Pick<Ctx, 'controller'>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'engine-flow-'))
  site = await mkdtemp(join(tmpdir(), 'engine-site-'))
  previous.VERBS_DIR = process.env.VERBS_DIR
  previous.SITE_PATH = process.env.SITE_PATH
  process.env.VERBS_DIR = dir
  process.env.SITE_PATH = site
  started = []
  answers = []
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

const hostStatus = (status: Record<string, unknown>) =>
  writeFile(join(dir, 'engine-update-status.json'), JSON.stringify(status), 'utf8')

/** The smallest site.json the reader accepts, with the developer block as given. */
const committedSite = (developer?: { engineOverride: boolean }) =>
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

function idOf(outcome: EngineUpdateOutcome): string {
  if (!outcome.ok) throw new Error(`expected an update, got ${outcome.code}: ${outcome.reason}`)
  return outcome.id
}

describe('an update with nothing in the way', () => {
  it('starts the engine update with only the actor as its payload', async () => {
    await committedSite()
    const { runEngineUpdate } = await flow()
    expect(idOf(await runEngineUpdate({ ctx, actor: 'op@example.test' }))).toBe('r1')
    expect(started[0]?.slice(0, 2)).toEqual(['engine-update', {}])
    expect(JSON.parse(String(started[0]?.[2]))).toEqual({ actor: 'op@example.test' })
  })

  it('needs no site.json to exist', async () => {
    // A box before its first write has no override either.
    const { runEngineUpdate } = await flow()
    expect((await runEngineUpdate({ ctx, actor: 'op' })).ok).toBe(true)
  })
})

describe('an engine override', () => {
  it('is refused before anything is asked', async () => {
    await committedSite({ engineOverride: true })
    const { runEngineUpdate } = await flow()
    expect(await runEngineUpdate({ ctx, actor: 'op' })).toEqual({
      ok: false,
      code: 'refused',
      reason:
        'clear the engine override first — the running system is built from the engine clone, not from the pinned engine',
    })
    expect(started).toEqual([])
  })

  it('off is no override', async () => {
    await committedSite({ engineOverride: false })
    const { runEngineUpdate } = await flow()
    expect((await runEngineUpdate({ ctx, actor: 'op' })).ok).toBe(true)
  })
})

describe('an update the host is already running', () => {
  it('is refused without asking the helper', async () => {
    await hostStatus({ id: 'abc', state: 'running', phase: 'building' })
    const { runEngineUpdate } = await flow()
    expect(await runEngineUpdate({ ctx, actor: 'op' })).toEqual({
      ok: false,
      code: 'busy',
      reason: 'an engine update is already running (building)',
    })
    expect(started).toEqual([])
  })
})

describe('two callers at once', () => {
  it('start one run: the helper refuses the other', async () => {
    answers = [
      undefined,
      {
        run: 'r2',
        verb: 'engine-update',
        outcome: 'refused',
        detail: 'daedalus-engine-update@r1 is still running; wait for it to finish',
        verbs: [],
      },
    ]
    const { runEngineUpdate } = await flow()
    const [a, b] = await Promise.all([
      runEngineUpdate({ ctx, actor: 'one' }),
      runEngineUpdate({ ctx, actor: 'two' }),
    ])
    expect(idOf(a)).toBe('r1')
    expect(b).toEqual({
      ok: false,
      code: 'busy',
      reason: 'daedalus-engine-update@r1 is still running; wait for it to finish',
    })
  })
})
