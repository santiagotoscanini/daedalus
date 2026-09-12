import { describe, expect, it } from 'vitest'
import { readiness } from './readiness'

const IMAGE = 'registry.toscanini.me/voyra:latest'

const ids = (cs: readonly { id: string }[]) => cs.map((c) => c.id)

describe('readiness — the image has not been built', () => {
  const r = readiness({ imageState: 'missing', effectiveImage: IMAGE })

  it('leaves exactly one thing to do', () => {
    expect(ids(r.act)).toEqual(['image'])
    expect(r.settled).toEqual([])
  })

  it('says the image has not been built', () => {
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
  const r = readiness({ imageState: 'present', effectiveImage: IMAGE })

  it('is ready with nothing to act on', () => {
    expect(r.ready).toBe(true)
    expect(r.act).toEqual([])
    expect(ids(r.settled)).toEqual(['image'])
    expect(r.verdict.state).toBe('ok')
  })
})

describe('readiness — an image this box cannot see', () => {
  const r = readiness({ imageState: 'unverifiable', effectiveImage: 'ghcr.io/someone/fork:v2' })

  it('is not ready, but is not a failure either', () => {
    expect(r.ready).toBe(false)
    expect(r.verdict.state).toBe('unknown')
    expect(r.verdict.headline).toContain('cannot see')
  })

  it('asks for nothing: an override on another registry is a legitimate app', () => {
    expect(r.act).toEqual([])
    expect(ids(r.settled)).toContain('image')
    expect(r.settled[0]?.fix).toBeUndefined()
  })
})
