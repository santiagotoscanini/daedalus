import { describe, expect, it } from 'vitest'
import { type Readiness, type RepoBuild, readiness } from './readiness'

const IMAGE = 'registry.toscanini.me/voyra:latest'

const ids = (cs: readonly { id: string }[]) => cs.map((c) => c.id)
const by = (r: Readiness, id: string) => [...r.act, ...r.settled].find((c) => c.id === id)

describe('readiness — the image has not been built', () => {
  const r = readiness({ imageState: 'missing', effectiveImage: IMAGE, repoBuild: 'railpack' })

  it('does not treat it as a failure: it is where every new app starts', () => {
    expect(r.act).toEqual([])
    expect(ids(r.settled)).toEqual(['image', 'build-config'])
    expect(r.ready).toBe(true)
    expect(r.verdict.state).toBe('ok')
  })

  it('says what happens next instead of what is blocked', () => {
    expect(r.verdict.headline).toContain('declared')
    expect(by(r, 'image')?.detail).toContain('expected')
    expect(by(r, 'image')?.fix).toContain('site/apps.json')
  })

  it('carries the effective image reference as the subject', () => {
    expect(r.verdict.subject).toBe(IMAGE)
  })
})

describe('readiness — the image is there', () => {
  const r = readiness({ imageState: 'present', effectiveImage: IMAGE, repoBuild: 'railpack' })

  it('says the app can be promoted as soon as it is applied', () => {
    expect(r.ready).toBe(true)
    expect(r.act).toEqual([])
    expect(r.verdict.state).toBe('ok')
    expect(r.verdict.headline).toContain('promoted')
  })
})

describe('readiness — an image this box cannot see', () => {
  const r = readiness({
    imageState: 'unverifiable',
    effectiveImage: 'ghcr.io/someone/fork:v2',
    repoBuild: 'railpack',
  })

  it('is unknown, not a failure, and asks for nothing', () => {
    expect(r.verdict.state).toBe('unknown')
    expect(r.verdict.headline).toContain('cannot see')
    expect(r.act).toEqual([])
    expect(by(r, 'image')?.fix).toBeUndefined()
  })

  it('still settles: an override on another registry is a legitimate app', () => {
    expect(r.ready).toBe(true)
    expect(ids(r.settled)).toContain('image')
  })
})

describe('readiness — how the repo will be built', () => {
  const withBuild = (repoBuild: RepoBuild) =>
    readiness({ imageState: 'missing', effectiveImage: IMAGE, repoBuild })

  it('railpack.json settles it', () => {
    const r = withBuild('railpack')
    expect(by(r, 'build-config')?.state).toBe('ok')
    expect(by(r, 'build-config')?.detail).toContain('railpack.json')
  })

  it('a Dockerfile settles it too, and names the strategy', () => {
    const r = withBuild('dockerfile')
    expect(by(r, 'build-config')?.state).toBe('ok')
    expect(by(r, 'build-config')?.fix).toContain('Dockerfile')
    expect(r.act).toEqual([])
  })

  it('neither is a warning — never a blocker', () => {
    const r = withBuild('none')
    expect(ids(r.act)).toEqual(['build-config'])
    expect(by(r, 'build-config')?.state).toBe('warn')
    expect(r.verdict.state).toBe('warn')
    expect(r.ready).toBe(false)
    // The whole point of the row: zero-config Railpack is possible, and has
    // never once been enough here.
    expect(by(r, 'build-config')?.fix).toContain('zero-config')
  })

  it('a GitHub that will not answer is unknown, and asks for nothing', () => {
    const r = withBuild('unknown')
    expect(by(r, 'build-config')?.state).toBe('unknown')
    expect(r.act).toEqual([])
    expect(r.verdict.state).toBe('unknown')
  })
})
