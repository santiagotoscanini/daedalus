import { describe, expect, it } from 'vitest'
import { decode } from './contract/decode'
import {
  buildManifest,
  CHECK_RUN_NAME,
  checkRunOutput,
  classifyPush,
  GITHUB_APP_EVENTS,
  GITHUB_APP_FILE,
  GITHUB_APP_PERMISSIONS,
  type GithubPushEvent,
  installUrl,
  type PushContext,
  type PushIgnoreReason,
  pushEventDecoder,
  SUMMARY_MAX_BYTES,
  SUMMARY_TRUNCATED_SUFFIX,
  TEXT_MAX_BYTES,
  TEXT_OMITTED_PREFIX,
} from './github-app'

const bytes = (s: string) => new TextEncoder().encode(s).length

describe('buildManifest', () => {
  it('has the exact shape GitHub registers', () => {
    expect(
      buildManifest({
        name: 'daedalus-s2',
        baseDomain: 'example.com',
        controlPlaneHost: 'daedalus-app.example.com',
      }),
    ).toEqual({
      name: 'daedalus-s2',
      url: 'https://daedalus-app.example.com',
      hook_attributes: { url: 'https://hooks.example.com/api/github/webhook', active: true },
      redirect_url: 'https://daedalus-app.example.com/settings/github/callback',
      setup_url: 'https://daedalus-app.example.com/settings?tab=integrations',
      setup_on_update: true,
      public: false,
      default_permissions: {
        contents: 'read',
        metadata: 'read',
        checks: 'write',
        deployments: 'write',
        pull_requests: 'write',
      },
      default_events: ['push', 'repository'],
    })
  })

  it('subscribes to no installation* event and no statuses permission', () => {
    const m = buildManifest({ name: 'x', baseDomain: 'd.io', controlPlaneHost: 'c.d.io' })
    expect(m.default_events.some((e) => e.startsWith('installation'))).toBe(false)
    expect(m.default_events).not.toContain('pull_request')
    expect(Object.keys(m.default_permissions)).not.toContain('statuses')
  })

  it('hands out copies, never the shared constants', () => {
    const m = buildManifest({ name: 'x', baseDomain: 'd.io', controlPlaneHost: 'c.d.io' })
    m.default_events.push('pull_request')
    m.default_permissions.administration = 'write'
    expect(GITHUB_APP_EVENTS).toEqual(['push', 'repository'])
    expect(Object.keys(GITHUB_APP_PERMISSIONS)).not.toContain('administration')
  })

  it('names its constants', () => {
    expect(GITHUB_APP_FILE).toBe('vault/github-app.sops')
    expect(CHECK_RUN_NAME).toBe('daedalus')
    expect(installUrl('daedalus-s2')).toBe('https://github.com/apps/daedalus-s2/installations/new')
  })
})

// ── push ───────────────────────────────────────────────────────────────────

const SHA = 'a'.repeat(40)
const OWNER = 1_000_001
const INSTALLATION = 42
const REPO_ID = 987_654

const push = (over: Partial<GithubPushEvent> = {}): GithubPushEvent => ({
  ref: 'refs/heads/main',
  before: 'b'.repeat(40),
  after: SHA,
  deleted: false,
  forced: false,
  repository: {
    id: REPO_ID,
    name: 'Iris',
    full_name: 'owner/Iris',
    default_branch: 'main',
    fork: false,
    owner: { id: OWNER, login: 'owner' },
  },
  installation: { id: INSTALLATION },
  head_commit: { id: SHA, message: 'feat: x', author: { name: 'Owner' } },
  sender: { login: 'owner' },
  ...over,
})

const repoWith = (over: Partial<GithubPushEvent['repository']>) => ({
  ...push().repository,
  ...over,
})

const ctx = (over: Partial<PushContext> = {}): PushContext => ({
  ownerId: OWNER,
  installationId: INSTALLATION,
  app: { githubRepoId: REPO_ID },
  ...over,
})

describe('pushEventDecoder', () => {
  it('reads a delivery, dropping what it does not need', () => {
    const raw = {
      ...push(),
      commits: [{ id: 'c'.repeat(40) }],
      pusher: { name: 'owner' },
      repository: { ...push().repository, private: true, master_branch: 'main' },
    }
    const ev = decode(pushEventDecoder, raw)
    expect(ev).toEqual(push())
    expect('commits' in ev).toBe(false)
  })

  it('tolerates a branch delete and a delivery without installation or sender', () => {
    const { installation: _i, sender: _s, ...rest } = push()
    const ev = decode(pushEventDecoder, { ...rest, deleted: true, head_commit: null })
    expect(ev.installation).toBeNull()
    expect(ev.sender).toBeNull()
    expect(ev.head_commit).toBeNull()
  })

  it('names the path of a malformed field', () => {
    expect(() =>
      decode(pushEventDecoder, { ...push(), repository: repoWith({ id: '1' as never }) }),
    ).toThrow('repository.id')
  })
})

describe('classifyPush', () => {
  const cases: [string, GithubPushEvent, PushContext, PushIgnoreReason][] = [
    ['branch delete', push({ deleted: true, after: '0'.repeat(40) }), ctx(), 'deleted'],
    ['tag push', push({ ref: 'refs/tags/v1.0.0' }), ctx(), 'tag'],
    ['tag named like the branch', push({ ref: 'refs/tags/main' }), ctx(), 'tag'],
    ['other branch', push({ ref: 'refs/heads/feature' }), ctx(), 'non-default-branch'],
    ['branch prefix only', push({ ref: 'refs/heads/main2' }), ctx(), 'non-default-branch'],
    [
      'default branch moved',
      push({ repository: repoWith({ default_branch: 'trunk' }) }),
      ctx(),
      'non-default-branch',
    ],
    ['zero after', push({ after: '0'.repeat(40) }), ctx(), 'zero-sha'],
    ['uppercase sha', push({ after: 'A'.repeat(40) }), ctx(), 'invalid-sha'],
    ['short sha', push({ after: 'a'.repeat(39) }), ctx(), 'invalid-sha'],
    ['sha-256 length', push({ after: 'a'.repeat(64) }), ctx(), 'invalid-sha'],
    ['empty after', push({ after: '' }), ctx(), 'invalid-sha'],
    [
      'other owner',
      push({ repository: repoWith({ owner: { id: 7, login: 'owner' } }) }),
      ctx(),
      'owner-mismatch',
    ],
    ['fork', push({ repository: repoWith({ fork: true }) }), ctx(), 'fork'],
    [
      'other installation',
      push({ installation: { id: INSTALLATION + 1 } }),
      ctx(),
      'installation-mismatch',
    ],
    ['no app', push(), ctx({ app: null }), 'no-app'],
    ['repo id not pinned yet', push(), ctx({ app: { githubRepoId: null } }), 'repo-not-pinned'],
    [
      'repo recreated under the same name',
      push({ repository: repoWith({ id: REPO_ID + 1 }) }),
      ctx(),
      'repo-mismatch',
    ],
  ]

  it.each(cases)('ignores: %s', (_label, event, context, reason) => {
    expect(classifyPush(event, context)).toEqual({ kind: 'ignore', reason })
  })

  it('checks in order: the first failing rule names the reason', () => {
    const everythingWrong = push({
      ref: 'refs/heads/feature',
      after: 'nope',
      repository: repoWith({ fork: true, owner: { id: 7, login: 'x' } }),
    })
    expect(classifyPush(everythingWrong, ctx({ app: null }))).toEqual({
      kind: 'ignore',
      reason: 'non-default-branch',
    })
    expect(classifyPush(push({ repository: repoWith({ fork: true, id: 1 }) }), ctx())).toEqual({
      kind: 'ignore',
      reason: 'fork',
    })
  })

  it('builds the tip of the default branch, keyed on after, lowercasing the name', () => {
    expect(classifyPush(push({ forced: true }), ctx())).toEqual({
      kind: 'build',
      sha: SHA,
      repoId: REPO_ID,
      repoName: 'iris',
    })
  })

  it('never reads commits[] or head_commit for the sha', () => {
    const ev = push({ head_commit: { id: 'c'.repeat(40), message: '', author: { name: '' } } })
    expect(classifyPush(ev, ctx())).toMatchObject({ kind: 'build', sha: SHA })
  })

  it('skips the installation check unless both ids are known', () => {
    expect(classifyPush(push({ installation: null }), ctx())).toMatchObject({ kind: 'build' })
    expect(
      classifyPush(push({ installation: { id: 999 } }), ctx({ installationId: null })),
    ).toMatchObject({ kind: 'build' })
  })

  it('never lets a push pin the repo id: an unpinned app ignores every repo', () => {
    for (const id of [REPO_ID, 5]) {
      expect(
        classifyPush(push({ repository: repoWith({ id }) }), ctx({ app: { githubRepoId: null } })),
      ).toEqual({ kind: 'ignore', reason: 'repo-not-pinned' })
    }
  })
})

// ── check run output ───────────────────────────────────────────────────────

describe('checkRunOutput', () => {
  const esc = String.fromCharCode(0x1b)
  const noReplacement = (s: string) => expect(s).not.toContain('�')

  it('passes short output through, ANSI stripped everywhere', () => {
    expect(
      checkRunOutput({
        title: `${esc}[1mBuilt${esc}[0m`,
        summary: `${esc}[32m✓${esc}[0m checks`,
        logTail: `${esc}[90m│${esc}[0m step 1\n❯ step 2\n`,
      }),
    ).toEqual({ title: 'Built', summary: '✓ checks', text: '│ step 1\n❯ step 2\n' })
  })

  it('keeps the summary at exactly the limit, truncates one byte over', () => {
    const exact = 'x'.repeat(SUMMARY_MAX_BYTES)
    expect(checkRunOutput({ title: '', summary: exact, logTail: '' }).summary).toBe(exact)

    const over = checkRunOutput({ title: '', summary: `${exact}y`, logTail: '' }).summary
    expect(bytes(over)).toBe(SUMMARY_MAX_BYTES)
    expect(over.endsWith(SUMMARY_TRUNCATED_SUFFIX)).toBe(true)
    expect(over.startsWith('xxx')).toBe(true)
  })

  it('keeps the text at exactly the limit, keeps the tail one byte over', () => {
    const line = 'y'.repeat(99)
    const exact = `${`${line}\n`.repeat(TEXT_MAX_BYTES / 100 - 1)}${'z'.repeat(100)}`
    expect(bytes(exact)).toBe(TEXT_MAX_BYTES)
    expect(checkRunOutput({ title: '', summary: '', logTail: exact }).text).toBe(exact)

    const text = checkRunOutput({ title: '', summary: '', logTail: `a\n${exact}` }).text
    expect(bytes(text)).toBeLessThanOrEqual(TEXT_MAX_BYTES)
    expect(text.startsWith(TEXT_OMITTED_PREFIX)).toBe(true)
    expect(text.endsWith('z'.repeat(100))).toBe(true)
    // Starts on a whole line, never a fragment of one.
    const body = text.slice(TEXT_OMITTED_PREFIX.length)
    expect(
      body
        .split('\n')
        .slice(0, -1)
        .every((l) => l === line),
    ).toBe(true)
  })

  it('measures after stripping: ANSI bytes do not count against the limit', () => {
    const plain = '│'.repeat(Math.floor(TEXT_MAX_BYTES / 3)) + 'x'.repeat(TEXT_MAX_BYTES % 3)
    expect(bytes(plain)).toBe(TEXT_MAX_BYTES)
    const coloured = `${esc}[31m${plain}${esc}[0m`
    expect(checkRunOutput({ title: '', summary: '', logTail: coloured }).text).toBe(plain)
  })

  it('never splits a multibyte glyph in a single over-long line', () => {
    for (const glyph of ['✓', '❯', '│']) {
      const log = glyph.repeat(Math.ceil(TEXT_MAX_BYTES / 3) + 7)
      const { text } = checkRunOutput({ title: '', summary: '', logTail: log })
      expect(bytes(text)).toBeLessThanOrEqual(TEXT_MAX_BYTES)
      expect(bytes(text)).toBeGreaterThan(TEXT_MAX_BYTES - 3)
      noReplacement(text)
      expect([...text.slice(TEXT_OMITTED_PREFIX.length)].every((c) => c === glyph)).toBe(true)
    }
  })

  it('never splits a multibyte glyph at the summary cut, whatever the offset', () => {
    for (const pad of ['', 'a', 'ab']) {
      const summary = pad + '❯'.repeat(SUMMARY_MAX_BYTES / 3 + 1)
      const out = checkRunOutput({ title: '', summary, logTail: '' }).summary
      expect(bytes(out)).toBeLessThanOrEqual(SUMMARY_MAX_BYTES)
      expect(bytes(out)).toBeGreaterThan(SUMMARY_MAX_BYTES - 3)
      noReplacement(out)
    }
  })

  it('keeps the tail of a real-looking coloured log with glyph lines', () => {
    const lines = Array.from(
      { length: 5_000 },
      (_, i) => `${esc}[36m│${esc}[0m ${esc}[32m✓${esc}[0m step ${i} ❯ ok`,
    )
    const { text } = checkRunOutput({ title: '', summary: '', logTail: lines.join('\n') })
    expect(bytes(text)).toBeLessThanOrEqual(TEXT_MAX_BYTES)
    expect(text).not.toContain(esc)
    noReplacement(text)
    expect(text.endsWith('│ ✓ step 4999 ❯ ok')).toBe(true)
    expect(text.slice(TEXT_OMITTED_PREFIX.length)).toMatch(/^│ ✓ step \d+ ❯ ok\n/)
  })
})
