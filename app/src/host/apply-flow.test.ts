import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../core/ctx'
import type { ApplyOutcome } from './apply-flow'

// Two Applies must never both run, and a refused one must never reach the
// host.
//
// `runApply` hands the finished bytes of apps.json (and site.json, nodes.json)
// to the root helper's `apply`, and the host commits and rebuilds from
// exactly those bytes. This file proves what keeps a second one out: the
// `running` check, `serialised()` keeping two callers from interleaving their
// check and their start, and the helper's one-run-at-a-time, whose refusal is
// the answer. A fake Ctx's controller records every start, because "refused"
// has to mean "asked nothing" rather than "returned an object saying no".
// Everything behind it — the registry, the site document, the settings row —
// is mocked at the module boundary, so this file is about the lock and
// nothing else.
//
// `chain` is module-scoped with no reset hook, so every test takes a FRESH
// module: `vi.resetModules()` then `await import`.

const h = vi.hoisted(() => ({
  apps: [{ name: 'iris', managedInNix: false }],
  drift: ['image'] as string[],
  siteChanges: [] as string[],
}))

vi.mock('../lib/repo/apps', () => ({ listApps: async () => h.apps }))
vi.mock('../lib/apps/manifest-map', () => ({
  driftOf: () => h.drift,
  toRegistryExport: () => ({ schemaVersion: 3, apps: {} }),
}))
vi.mock('./nix-manifest', () => ({ manifestEntries: async () => [] }))
// The machines ride every Apply as nodes.json; none here, so the render is
// the empty document and "changed" is whether the temp site dir holds it.
vi.mock('../lib/repo/nodes', () => ({ nodesForFile: async () => [] }))
vi.mock('../core/ctx', () => ({ makeCtx: async () => ({}) }))
vi.mock('../core/site', () => ({
  siteEdit: async () => ({ changes: h.siteChanges, render: { after: '{"site":true}\n' } }),
  // The README and the provenance stamp ride every Apply. Fixed bytes here: the real stamp
  // reads three host snapshots and a clock, none of which this file has, and
  // what it says is core/site's business, not the flow's.
  renderSiteMeta: async () => ({ 'README.md': '# site\n', 'daedalus.json': '{"stamp":true}\n' }),
}))
vi.mock('../lib/repo/settings', () => ({
  readSetting: async () => false,
  SETTING_KEYS: { siteCommit: 'site.commit' },
}))

let dir: string
let site: string
let started: unknown[][]
let answers: unknown[]
const previous: Record<string, string | undefined> = {}

const ctx = {
  controller: {
    call: async (m: string, p: { verb: string; selectors: object; payload?: string }) => {
      if (m === 'root.follow') return { run: { outcome: null, detail: '' } }
      started.push([p.verb, p.selectors, p.payload])
      const run = `r${String(started.length)}`
      return answers.shift() ?? { run, verb: 'apply', outcome: null, detail: '', verbs: [] }
    },
  },
} as unknown as Pick<Ctx, 'controller'>

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'apply-flow-'))
  // An empty site dir of its own: the committed nodes.json is read from
  // SITE_PATH, and the box's real one would make "nothing to apply" depend
  // on which machines it has approved.
  site = await mkdtemp(join(tmpdir(), 'apply-flow-site-'))
  for (const k of ['VERBS_DIR', 'SITE_PATH']) previous[k] = process.env[k]
  process.env.VERBS_DIR = dir
  process.env.SITE_PATH = site
  started = []
  answers = []
  h.apps = [{ name: 'iris', managedInNix: false }]
  h.drift = ['image']
  h.siteChanges = []
})

afterEach(async () => {
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(dir, { recursive: true, force: true })
  await rm(site, { recursive: true, force: true })
})

/** A fresh module, so the previous test's `chain` is gone. */
async function flow() {
  vi.resetModules()
  return import('./apply-flow')
}

const hostStatus = (status: Record<string, unknown>) =>
  writeFile(join(dir, 'apply-status.json'), JSON.stringify(status), 'utf8')

/** The payload of the nth start. */
const payload = (n: number) =>
  JSON.parse(String(started[n]?.[2])) as {
    actor: string
    summary: string
    commit: boolean
    files: Record<string, string>
  }

function idOf(outcome: ApplyOutcome): string {
  if (!outcome.ok) throw new Error(`expected an apply, got ${outcome.code}: ${outcome.reason}`)
  return outcome.id
}

describe('an apply', () => {
  it('starts the root helper’s apply with the rendered files and what to record', async () => {
    const { runApply } = await flow()
    expect(idOf(await runApply(ctx, 'santiago'))).toBe('r1')
    expect(started[0]?.slice(0, 2)).toEqual(['apply', {}])
    const p = payload(0)
    expect([p.actor, p.summary, p.commit]).toEqual(['santiago', 'iris: image', false])
    expect(Object.keys(p.files).sort()).toEqual([
      'README.md',
      'apps.json',
      'daedalus.json',
      'nodes.json',
    ])
  })
})

describe('an apply the host is already running', () => {
  it('is refused, and asks the helper nothing', async () => {
    await hostStatus({ id: 'abc', state: 'running', phase: 'rebuilding' })
    const { runApply } = await flow()

    expect(await runApply(ctx, 'santiago')).toEqual({
      ok: false,
      code: 'busy',
      reason: 'an apply is already running (rebuilding)',
    })
    expect(started).toEqual([])
  })
})

describe('two callers at once', () => {
  it('start one run: the helper refuses the other, in its words', async () => {
    answers = [
      undefined,
      {
        run: 'r2',
        verb: 'apply',
        outcome: 'refused',
        detail: 'daedalus-apply@r1 is still running; wait for it to finish',
        verbs: [],
      },
    ]
    const { runApply } = await flow()

    // Un-awaited on purpose: both enter before either has started, which is
    // the interleaving `serialised()` orders and the helper refuses.
    const [a, b] = await Promise.all([runApply(ctx, 'one'), runApply(ctx, 'two')])
    expect(idOf(a)).toBe('r1')
    expect(b).toEqual({
      ok: false,
      code: 'busy',
      reason: 'daedalus-apply@r1 is still running; wait for it to finish',
    })
  })
})

describe('an apply with nothing to carry', () => {
  it('asks nothing and does not block the next one', async () => {
    h.drift = []
    const { runApply } = await flow()

    expect(await runApply(ctx, 'santiago')).toEqual({
      ok: false,
      code: 'noop',
      reason: 'nothing to apply',
    })
    expect(started).toEqual([])

    h.drift = ['image']
    expect(idOf(await runApply(ctx, 'santiago'))).toBeTruthy()
  })
})

describe('a secret', () => {
  it('is its own Apply, refused while anything else is pending', async () => {
    const { runSecretApply, secretApplyBlocker } = await flow()
    const secret = {
      file: 'vault/cloudflare-api-token.sops' as const,
      name: 'Cloudflare API token',
      ciphertext: 'sealed',
    }
    expect(await secretApplyBlocker(ctx)).toMatch(/^Apply or undo the pending changes first/)
    expect((await runSecretApply(ctx, 'santiago', secret)).ok).toBe(false)
    expect(started).toEqual([])

    h.drift = []
    expect(await secretApplyBlocker(ctx)).toBeNull()
    expect(idOf(await runSecretApply(ctx, 'santiago', secret))).toBe('r1')
    expect(payload(0).files['vault/cloudflare-api-token.sops']).toBe('sealed')
    expect(payload(0).summary).toBe('replace Cloudflare API token')
  })
})
