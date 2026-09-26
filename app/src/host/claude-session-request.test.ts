import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  readClaudeSessionStatus,
  requestClaudeSessionResume,
  requestClaudeSessionStop,
} from './claude-session-request'

// The file names on both halves of this bridge are a contract with a host unit
// no TypeScript check reaches: nix/stacks/daedalus/daedalus-verbs.nix watches
// `claude-session-request.json` and its agent writes
// `claude-session-status.json`. A rename here fails nothing — the buttons
// would simply stop reaching the box, silently, with request files piling up
// under a name nothing watches.
//
// The rest of this file is about the one property that matters more than the
// names: a selector this side refuses must leave the bridge directory exactly
// as it found it. The host agent is the real allowlist and validates
// everything again, but a refusal that still wrote a request file would mean a
// malformed id reaching a root-side agent, and a refusal that still wrote a
// STATUS would erase the outcome of the last real action from the page.

let dir: string
let previous: string | undefined

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'claude-session-'))
  previous = process.env.APPLY_DIR
  process.env.APPLY_DIR = dir
})

afterEach(async () => {
  if (previous === undefined) delete process.env.APPLY_DIR
  else process.env.APPLY_DIR = previous
  await rm(dir, { recursive: true, force: true })
})

const UUID = '11111111-2222-4333-8444-555555555555'

describe('requestClaudeSessionResume', () => {
  it('writes claude-session-request.json carrying the action, the session and the actor', async () => {
    const id = await requestClaudeSessionResume({ session: UUID, actor: 'someone' })

    const body = JSON.parse(await readFile(join(dir, 'claude-session-request.json'), 'utf8')) as {
      id: string
      action: string
      session: string
      actor: string
      requestedAt: string
    }
    expect(body.id).toBe(id)
    expect(body.action).toBe('resume')
    expect(body.session).toBe(UUID)
    expect(body.actor).toBe('someone')
    expect(Number.isFinite(Date.parse(body.requestedAt))).toBe(true)
  })

  // The charset, which is the host agent's first layer restated. Every one of
  // these is a way a selector could stop being a selector: a traversal, a
  // command substitution, a unit-name escape, or simply the wrong case — the
  // whole tree on this box is lowercase.
  it.each([
    ['a traversal', '../../etc/shadow'],
    ['a command substitution', '$(id)'],
    ['a shell separator', `${UUID}; rm -rf /`],
    ['a systemd instance escape', '11111111-2222-4333-8444-555555555555.service'],
    ['upper case', 'AAAAAAAA-BBBB-4CCC-8DDD-EEEEEEEEEEEE'],
    ['a short agent id', 'deadbeef'],
    ['the empty string', ''],
  ])('refuses %s, and publishes nothing at all', async (_what, session) => {
    await expect(requestClaudeSessionResume({ session, actor: 'someone' })).rejects.toThrow(
      /not a session id/,
    )
    expect(await readdir(dir)).toEqual([])
  })
})

describe('requestClaudeSessionStop', () => {
  it('takes a uuid — a session this box started, ended by systemctl stop', async () => {
    await requestClaudeSessionStop({ session: UUID, actor: 'someone' })
    const body = JSON.parse(await readFile(join(dir, 'claude-session-request.json'), 'utf8')) as {
      action: string
      session: string
    }
    expect(body).toMatchObject({ action: 'stop', session: UUID })
  })

  // `claude stop` takes the SHORT id, not the uuid. A stop that only accepted
  // uuids would silently have no verb for the background population.
  it('takes an eight-digit agent id — a background agent, ended by claude stop', async () => {
    await requestClaudeSessionStop({ session: 'deadbeef', actor: 'someone' })
    const body = JSON.parse(await readFile(join(dir, 'claude-session-request.json'), 'utf8')) as {
      action: string
      session: string
    }
    expect(body).toMatchObject({ action: 'stop', session: 'deadbeef' })
  })

  it.each([
    ['a traversal', '../../etc/shadow'],
    ['seven digits', 'deadbee'],
    ['nine digits', 'deadbeef0'],
    ['upper case', 'DEADBEEF'],
    ['a shell separator', 'deadbeef; reboot'],
  ])('refuses %s, and publishes nothing at all', async (_what, session) => {
    await expect(requestClaudeSessionStop({ session, actor: 'someone' })).rejects.toThrow(
      /not a session id/,
    )
    expect(await readdir(dir)).toEqual([])
  })

  // The sharpest version of the property: a refusal must not disturb a status
  // the host wrote about a REAL action, because the page renders that status.
  it('leaves an existing status file untouched when it refuses', async () => {
    const existing = `{"id":"abc","action":"resume","session":"${UUID}","state":"done"}`
    await writeFile(join(dir, 'claude-session-status.json'), existing, 'utf8')

    await expect(
      requestClaudeSessionStop({ session: 'not-an-id', actor: 'someone' }),
    ).rejects.toThrow(/not a session id/)

    expect(await readdir(dir)).toEqual(['claude-session-status.json'])
    expect(await readFile(join(dir, 'claude-session-status.json'), 'utf8')).toBe(existing)
  })
})

describe('readClaudeSessionStatus', () => {
  const IDLE = {
    id: null,
    action: null,
    session: null,
    state: 'idle',
    detail: '',
    error: '',
    startedAt: null,
    finishedAt: null,
  }

  it('reads idle before the host has ever answered', async () => {
    expect(await readClaudeSessionStatus()).toEqual(IDLE)
  })

  it('fills a partial status from the decoder rather than casting it', async () => {
    await writeFile(
      join(dir, 'claude-session-status.json'),
      `{"id":"abc","action":"resume","session":"${UUID}","state":"running"}`,
      'utf8',
    )
    expect(await readClaudeSessionStatus()).toEqual({
      ...IDLE,
      id: 'abc',
      action: 'resume',
      session: UUID,
      state: 'running',
    })
  })

  // An unreadable status is a broken host agent, and idle is the only honest
  // reading of it — a `state` nobody defined must never reach the buttons as a
  // state, because they re-enable on one of them.
  it('reads idle on a torn file and on a state the verb does not have', async () => {
    await writeFile(join(dir, 'claude-session-status.json'), '{"state":"runn', 'utf8')
    expect(await readClaudeSessionStatus()).toEqual(IDLE)
    await writeFile(join(dir, 'claude-session-status.json'), '{"state":"banana"}', 'utf8')
    expect(await readClaudeSessionStatus()).toEqual(IDLE)
    await writeFile(join(dir, 'claude-session-status.json'), '{"action":"reboot"}', 'utf8')
    expect(await readClaudeSessionStatus()).toEqual(IDLE)
  })
})
