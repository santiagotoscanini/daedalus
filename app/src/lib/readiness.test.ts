import { describe, expect, it } from 'vitest'
import type { Check } from './github-repos'
import { readiness } from './readiness'

const IMAGE = 'registry.toscanini.me/voyra:latest'

const ids = (cs: readonly { id: string }[]) => cs.map((c) => c.id)

/** The rows repoChecks emits for a repo with nothing in .github/workflows. */
const noWorkflows: Check[] = [
  {
    id: 'workflows',
    label: 'CI workflows',
    state: 'bad',
    detail: 'no .github/workflows in the repo',
    fix: 'Copy ci.yml and image.yml from an existing app repo.',
  },
  {
    id: 'image-workflow',
    label: 'Publishes an image to the box’s registry',
    state: 'unknown',
    detail: 'no workflow contents could be read',
  },
  {
    id: 'runner-compatible',
    label: 'Workflows run on this box’s runners',
    state: 'unknown',
    detail: 'no workflow contents could be read',
  },
  { id: 'containerfile', label: 'Dockerfile at the repo root', state: 'ok', detail: 'found' },
  { id: 'registry-secret', label: 'REGISTRY_PASSWORD repo secret', state: 'ok', detail: 'set' },
]

/** Everything the repo side can pass, passing. */
const allGood: Check[] = [
  { id: 'workflows', label: 'CI workflows', state: 'ok', detail: 'ci.yml, image.yml' },
  {
    id: 'image-workflow',
    label: 'Publishes an image to the box’s registry',
    state: 'ok',
    detail: 'image.yml pushes to zot, and can be run on demand',
  },
  {
    id: 'runner-compatible',
    label: 'Workflows run on this box’s runners',
    state: 'ok',
    detail: 'plain run: steps only',
  },
  { id: 'containerfile', label: 'Dockerfile at the repo root', state: 'ok', detail: 'found' },
  { id: 'registry-secret', label: 'REGISTRY_PASSWORD repo secret', state: 'ok', detail: 'set' },
]

describe('readiness — the no-workflows chain', () => {
  const r = readiness({ checks: noWorkflows, imageState: 'missing', effectiveImage: IMAGE })

  it('reports one actionable root cause', () => {
    expect(ids(r.act)).toEqual(['workflows'])
  })

  it('files every consequence as blocked, in dependency order', () => {
    expect(ids(r.blocked)).toEqual(['image-workflow', 'runner-compatible', 'image'])
  })

  it('tells each blocked row what it waits on', () => {
    expect(r.blocked.map((b) => b.waitingOn)).toEqual([
      'the workflows',
      'the workflows',
      'the workflows',
    ])
    expect(r.waitingOn).toBe('the workflows')
  })

  it('absorbs the root cause into the verdict rather than naming the symptom', () => {
    expect(r.verdict.headline).toBe('Nothing in this repo publishes an image yet')
    expect(r.verdict.headline).not.toContain('does not exist')
    expect(r.verdict.state).toBe('bad')
    expect(r.ready).toBe(false)
  })

  it('leaves the checks that stand on their own alone', () => {
    expect(ids(r.settled)).toEqual(['containerfile', 'registry-secret', 'runner-pat'])
  })
})

describe('readiness — everything passes but the image', () => {
  const r = readiness({ checks: allGood, imageState: 'missing', effectiveImage: IMAGE })

  it('leaves exactly one thing to do: run the workflow', () => {
    expect(ids(r.act)).toEqual(['image'])
    expect(r.blocked).toEqual([])
  })

  it('says the image has not been built, not that nothing builds it', () => {
    expect(r.verdict.headline).toContain('hasn’t been built yet')
    expect(r.verdict.state).toBe('bad')
    expect(r.ready).toBe(false)
  })

  it('carries the effective image reference as the subject', () => {
    expect(r.verdict.subject).toBe(IMAGE)
  })

  it('keeps the image row’s fix copy', () => {
    expect(r.act[0]?.fix).toContain('restart-loop')
  })
})

describe('readiness — the image is there', () => {
  const r = readiness({ checks: allGood, imageState: 'present', effectiveImage: IMAGE })

  it('is ready with nothing to act on', () => {
    expect(r.ready).toBe(true)
    expect(r.act).toEqual([])
    expect(r.blocked).toEqual([])
    expect(r.verdict.state).toBe('ok')
  })

  it('settles every check, including the two the platform synthesises', () => {
    expect(ids(r.settled)).toEqual([
      'workflows',
      'image-workflow',
      'runner-compatible',
      'containerfile',
      'registry-secret',
      'runner-pat',
      'image',
    ])
  })
})

describe('readiness — a published image with a repo that would not rebuild it', () => {
  const r = readiness({ checks: noWorkflows, imageState: 'present', effectiveImage: IMAGE })

  it('does not collapse: the image is fine, the repo is not', () => {
    expect(r.ready).toBe(false)
    expect(ids(r.act)).toEqual(['workflows'])
    expect(r.verdict.state).toBe('warn')
    expect(r.verdict.headline).toBe(
      'The image is published, but nothing in the repo would rebuild it',
    )
  })
})

describe('readiness — an image this box cannot see', () => {
  const r = readiness({
    checks: allGood,
    imageState: 'unverifiable',
    effectiveImage: 'ghcr.io/someone/fork:v2',
  })

  it('is not ready, but is not a failure either', () => {
    expect(r.ready).toBe(false)
    expect(r.verdict.state).toBe('unknown')
    expect(r.verdict.headline).toContain('cannot see')
  })

  it('blocks nothing and asks for nothing', () => {
    expect(r.act).toEqual([])
    expect(r.blocked).toEqual([])
    expect(ids(r.settled)).toContain('image')
  })
})

describe('readiness — warns are not blockers', () => {
  const withWarn: Check[] = allGood.map((c) =>
    c.id === 'containerfile'
      ? {
          ...c,
          state: 'warn' as const,
          detail: 'none at the root — fine if the workflow builds from elsewhere',
        }
      : c,
  )
  const r = readiness({ checks: withWarn, imageState: 'missing', effectiveImage: IMAGE })

  it('settles the Dockerfile warning instead of demanding it', () => {
    expect(ids(r.settled)).toContain('containerfile')
    expect(ids(r.act)).toEqual(['image'])
  })

  it('does not let a warn block the image', () => {
    expect(r.blocked).toEqual([])
    expect(r.verdict.headline).toContain('hasn’t been built yet')
  })
})

describe('readiness — a failing precondition outranks the image', () => {
  const noSecret: Check[] = allGood.map((c) =>
    c.id === 'registry-secret'
      ? { ...c, state: 'bad' as const, detail: 'not set, so the image push will 401' }
      : c,
  )
  const r = readiness({ checks: noSecret, imageState: 'missing', effectiveImage: IMAGE })

  it('acts on the secret and parks the image behind it', () => {
    expect(ids(r.act)).toEqual(['registry-secret'])
    expect(ids(r.blocked)).toEqual(['image'])
    expect(r.blocked[0]?.waitingOn).toBe('the registry secret')
  })

  it('says what would actually happen, not that the image is missing', () => {
    expect(r.verdict.headline).toContain('cannot sign in to the registry')
  })
})
