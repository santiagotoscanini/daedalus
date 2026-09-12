import { describe, expect, it } from 'vitest'
import type { GithubPushEvent } from './github-app'
import {
  alreadyHandled,
  appsPinnedTo,
  eventKind,
  isDeliveryId,
  isEventName,
  type PushApp,
  parsePayload,
  readAction,
  repoMove,
  repoMoveNote,
  repositoryId,
  routePush,
} from './webhook-routing'

const OWNER_ID = 29_045_597
const REPO_ID = 812_004_117
const SHA = '3f786850e387550fdab836ed7e6dc881de23001b'

const bytes = (s: string) => new TextEncoder().encode(s)

const push = (over: Partial<GithubPushEvent> = {}): GithubPushEvent => ({
  ref: 'refs/heads/main',
  before: '89e6c98d92887913cadf06b2adb97f26cde4849b',
  after: SHA,
  deleted: false,
  forced: false,
  repository: {
    id: REPO_ID,
    name: 'iris',
    full_name: 'santiagotoscanini/iris',
    default_branch: 'main',
    fork: false,
    owner: { id: OWNER_ID, login: 'santiagotoscanini' },
  },
  installation: { id: 1 },
  head_commit: null,
  sender: { login: 'santiagotoscanini' },
  ...over,
})

const app = (over: Partial<PushApp> = {}): PushApp => ({
  id: 'app-iris',
  githubRepoId: REPO_ID,
  buildOnBox: true,
  managedInNix: false,
  sourceMode: 'registry',
  buildStrategy: 'railpack',
  buildPublish: 'candidate',
  ...over,
})

const ctx = (a: PushApp | null = app()) => ({ ownerId: OWNER_ID, installationId: 1, app: a })

describe('delivery headers', () => {
  it('accepts GitHub delivery GUIDs only', () => {
    expect(isDeliveryId('72d3162e-cc78-11e3-81ab-4c9367dc0958')).toBe(true)
    expect(isDeliveryId('72D3162E-CC78-11E3-81AB-4C9367DC0958')).toBe(true)
    for (const bad of [null, '', '72d3162e', '72d3162e-cc78-11e3-81ab-4c9367dc0958x', '../x']) {
      expect(isDeliveryId(bad)).toBe(false)
    }
  })

  it('accepts event words only', () => {
    expect(isEventName('installation_repositories')).toBe(true)
    for (const bad of [null, '', 'Push', 'push\n', 'a'.repeat(65)]) {
      expect(isEventName(bad)).toBe(false)
    }
  })
})

describe('parsePayload', () => {
  it('returns a JSON object', () => {
    expect(parsePayload(bytes('{"zen":"ok"}'))).toEqual({ zen: 'ok' })
  })

  it.each([
    ['truncated JSON', bytes('{"a":')],
    ['an array', bytes('[1]')],
    ['null', bytes('null')],
    ['a number', bytes('7')],
    ['empty', bytes('')],
    ['invalid UTF-8', new Uint8Array([0x7b, 0x22, 0xff, 0x22, 0x7d])],
  ])('refuses %s', (_label, body) => {
    expect(parsePayload(body)).toBeNull()
  })
})

describe('event helpers', () => {
  it('reads a plain action word only', () => {
    expect(readAction({ action: 'renamed' })).toBe('renamed')
    expect(readAction({ action: 'Renamed; drop' })).toBeNull()
    expect(readAction({ action: 3 })).toBeNull()
    expect(readAction({})).toBeNull()
  })

  it('sorts events into what the route does with them', () => {
    expect(eventKind('ping')).toBe('ping')
    expect(eventKind('installation')).toBe('installation')
    expect(eventKind('installation_repositories')).toBe('installation')
    expect(eventKind('repository')).toBe('installation')
    expect(eventKind('push')).toBe('push')
    expect(eventKind('pull_request')).toBe('other')
  })

  it('names a repository move only for the moving actions', () => {
    expect(repoMove('repository', 'renamed')).toBe('renamed')
    expect(repoMove('repository', 'transferred')).toBe('transferred')
    expect(repoMove('repository', 'deleted')).toBe('deleted')
    expect(repoMove('repository', 'created')).toBeNull()
    expect(repoMove('installation', 'deleted')).toBeNull()
  })

  it('tells the operator a renamed repo still builds its pinned app', () => {
    const note = repoMoveNote('renamed', ['iris'])
    expect(note).toContain('still build iris')
    expect(note).toContain('renamed later')
    expect(repoMoveNote('transferred', ['iris'])).toContain('ignored')
    expect(repoMoveNote('deleted', ['iris', 'hermes'])).toContain('iris, hermes')
  })

  it('reads the repository id and the apps pinned to it', () => {
    expect(repositoryId({ repository: { id: REPO_ID } })).toBe(REPO_ID)
    expect(repositoryId({ repository: { id: '1' } })).toBeNull()
    expect(repositoryId({})).toBeNull()
    const apps = [
      { name: 'iris', githubRepoId: REPO_ID },
      { name: 'hermes', githubRepoId: null },
    ]
    expect(appsPinnedTo(apps, REPO_ID)).toEqual(['iris'])
    expect(appsPinnedTo(apps, 1)).toEqual([])
  })
})

describe('routePush', () => {
  it('queues the app’s own strategy and publish mode on the main lane', () => {
    expect(routePush(push(), ctx())).toEqual({
      kind: 'queue',
      intent: {
        appId: 'app-iris',
        lane: 'main',
        sha: SHA,
        strategy: 'railpack',
        publish: 'candidate',
        requestedBy: 'webhook',
        actor: 'santiagotoscanini',
      },
    })
  })

  it('has no actor without a sender', () => {
    const r = routePush(push({ sender: null }), ctx())
    expect(r.kind === 'queue' && r.intent.actor).toBeNull()
  })

  it('passes classifyPush’s refusals through before looking at the app', () => {
    expect(routePush(push({ ref: 'refs/heads/dev' }), ctx(app({ buildOnBox: false })))).toEqual({
      kind: 'ignore',
      reason: 'non-default-branch',
    })
    expect(routePush(push(), ctx(null))).toEqual({ kind: 'ignore', reason: 'no-app' })
  })

  it.each([
    [{ buildOnBox: false }, 'box-builds-off'],
    [{ managedInNix: true }, 'managed-in-nix'],
    [{ sourceMode: 'local' }, 'not-registry-mode'],
    [{ buildStrategy: 'nixpacks' }, 'invalid-build-settings'],
    [{ buildPublish: 'preview' }, 'invalid-build-settings'],
  ] as const)('refuses an app with %o', (over, reason) => {
    expect(routePush(push(), ctx(app(over)))).toEqual({ kind: 'ignore', reason })
  })
})

describe('alreadyHandled', () => {
  const intent = { appId: 'app-iris', lane: 'main' as const, sha: SHA }

  it('skips a sha the lane is building', () => {
    const active = [{ appId: 'app-iris', lane: 'main', sha: SHA }]
    expect(alreadyHandled(intent, { active, lastSucceededSha: null })).toBe('already-running')
  })

  it('does not count the same sha building for another app or lane', () => {
    const active = [
      { appId: 'app-hermes', lane: 'main', sha: SHA },
      { appId: 'app-iris', lane: 'pr', sha: SHA },
    ]
    expect(alreadyHandled(intent, { active, lastSucceededSha: null })).toBeNull()
  })

  it('skips the lane’s newest success and nothing older', () => {
    expect(alreadyHandled(intent, { active: [], lastSucceededSha: SHA })).toBe('already-built')
    expect(
      alreadyHandled(intent, {
        active: [],
        lastSucceededSha: '89e6c98d92887913cadf06b2adb97f26cde4849b',
      }),
    ).toBeNull()
  })
})
