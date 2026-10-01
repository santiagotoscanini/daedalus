import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ctx } from '../core/ctx'

// The Claude Code pin as the app sees it: its status, believed while its run
// is (host/root-verb.ts), and its one flow — refused under an engine
// override or while an engine update runs, otherwise a detached
// `claude-code-update` whose payload is the actor. A fake Ctx's controller
// records the starts; the status files are real, in temp directories.

let verbs: string
let site: string
let started: unknown[][]
let follow: unknown
const previous: Record<string, string | undefined> = {}

const ctx = {
  controller: {
    call: async (m: string, p: { verb: string; selectors: object; payload?: string }) => {
      if (m === 'root.follow') return follow
      started.push([p.verb, p.selectors, p.payload])
      return { run: 'r1', verb: 'claude-code-update', outcome: null, detail: '', verbs: [] }
    },
  },
} as unknown as Pick<Ctx, 'controller'>

beforeEach(async () => {
  verbs = await mkdtemp(join(tmpdir(), 'ccupd-'))
  site = await mkdtemp(join(tmpdir(), 'ccupd-site-'))
  for (const k of ['VERBS_DIR', 'SITE_PATH']) previous[k] = process.env[k]
  process.env.VERBS_DIR = verbs
  process.env.SITE_PATH = site
  started = []
  follow = { run: { outcome: null, detail: '' } }
})

afterEach(async () => {
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const d of [verbs, site]) await rm(d, { recursive: true, force: true })
})

const status = (state: string, phase = 'committing') =>
  writeFile(
    join(verbs, 'claude-code-update-status.json'),
    JSON.stringify({
      id: 'r0',
      state,
      phase,
      error: '',
      from: '2.1.259',
      to: '2.1.281',
      startedAt: '2026-10-01T10:00:00Z',
      finishedAt: '2026-10-01T10:00:00Z',
      commit: '',
    }),
  )

async function modules() {
  vi.resetModules()
  return {
    ...(await import('./claude-code-update')),
    ...(await import('./claude-code-flow')),
  }
}

describe('the status', () => {
  it('a running pin is left alone while its run goes on, versions included', async () => {
    await status('running')
    const { readClaudeCodeUpdateStatus } = await modules()
    const s = await readClaudeCodeUpdateStatus(ctx)
    expect(s.state).toBe('running')
    expect(s.from).toBe('2.1.259')
    expect(s.to).toBe('2.1.281')
  })

  it('a running pin whose run has ended is failed, phase kept', async () => {
    await status('running')
    follow = { run: { outcome: 'failed', detail: '' } }
    const { readClaudeCodeUpdateStatus } = await modules()
    const s = await readClaudeCodeUpdateStatus(ctx)
    expect(s.state).toBe('failed')
    expect(s.phase).toBe('committing')
    expect(s.error).toMatch(/ended during "committing"/)
    expect(s.error).toMatch(/daedalus-engine-update@/)
  })
})

describe('runClaudeCodeUpdate', () => {
  it('starts the pin with the actor as its payload', async () => {
    const { runClaudeCodeUpdate } = await modules()
    expect(await runClaudeCodeUpdate({ ctx, actor: 'op@example.test' })).toEqual({
      ok: true,
      id: 'r1',
    })
    expect(started[0]?.slice(0, 2)).toEqual(['claude-code-update', {}])
    expect(JSON.parse(String(started[0]?.[2]))).toEqual({ actor: 'op@example.test' })
  })

  it('is refused while a pin runs, or while an engine update does', async () => {
    await status('running', 'fetching')
    let m = await modules()
    expect(await m.runClaudeCodeUpdate({ ctx, actor: 'op' })).toEqual({
      ok: false,
      code: 'busy',
      reason: 'a Claude Code pin is already running (fetching)',
    })
    await rm(join(verbs, 'claude-code-update-status.json'))
    await writeFile(
      join(verbs, 'engine-update-status.json'),
      JSON.stringify({ id: 'e1', state: 'running', phase: 'building' }),
    )
    m = await modules()
    expect(await m.runClaudeCodeUpdate({ ctx, actor: 'op' })).toMatchObject({
      ok: false,
      code: 'refused',
    })
    expect(started).toEqual([])
  })
})
