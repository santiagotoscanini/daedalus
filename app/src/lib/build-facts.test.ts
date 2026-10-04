import { describe, expect, it } from 'vitest'
import { cacheHitRatio, readBuildFacts } from './build-facts'

// The two keys as the host build agent writes them, and every way an older or
// newer agent can fail to: the point of the decoder is that none of them throws
// and none of them invents a number.

const IMAGE = {
  tags: ['sha-abc', 'latest'],
  layers: 3,
  layerSizes: [1_000, 2_000, 3_000],
  configSize: 500,
  mediaType: 'application/vnd.oci.image.manifest.v1+json',
}

const BUILD = {
  runner: 'buildkitd.service',
  cacheImported: true,
  cacheExported: false,
  stepsCached: 7,
  stepsTotal: 9,
}

describe('readBuildFacts', () => {
  it('reads both keys as the contract writes them', () => {
    expect(readBuildFacts({ image: IMAGE, build: BUILD })).toEqual({
      image: {
        tags: ['sha-abc', 'latest'],
        layers: 3,
        layerSizes: [1_000, 2_000, 3_000],
        configSize: 500,
        mediaType: 'application/vnd.oci.image.manifest.v1+json',
      },
      run: {
        runner: 'buildkitd.service',
        cacheImported: true,
        cacheExported: false,
        stepsCached: 7,
        stepsTotal: 9,
      },
    })
  })

  it('is null when an agent published neither — an older agent, or a build with no image', () => {
    expect(readBuildFacts({})).toBeNull()
    expect(readBuildFacts({ image: null, build: null })).toBeNull()
    expect(readBuildFacts({ image: 'yes', build: 7 })).toBeNull()
  })

  it('keeps the half that arrived', () => {
    expect(readBuildFacts({ image: IMAGE })?.run).toBeNull()
    expect(readBuildFacts({ build: BUILD })?.image).toBeNull()
  })

  it('blanks a mistyped field rather than the whole key', () => {
    const facts = readBuildFacts({
      image: { tags: ['ok', 7, ''], layers: 'three', layerSizes: [1, 'x', 2], configSize: null },
      build: { runner: 5, cacheImported: 'true', stepsCached: 2, stepsTotal: Number.NaN },
    })
    expect(facts?.image).toEqual({
      tags: ['ok'],
      layers: null,
      layerSizes: [1, 2],
      configSize: null,
      mediaType: null,
    })
    expect(facts?.run).toMatchObject({
      runner: null,
      cacheImported: null,
      stepsCached: 2,
      stepsTotal: null,
    })
  })

  it('reads an explicit null as the absent key the contract asks for', () => {
    // The contract is "omit the key"; agents have published explicit nulls.
    // Both must read the same way.
    const withNull = readBuildFacts({ build: { ...BUILD, stepsTotal: null } })?.run
    const omitted = readBuildFacts({
      build: {
        runner: BUILD.runner,
        cacheImported: true,
        cacheExported: false,
        stepsCached: 7,
      },
    })?.run
    expect(withNull?.stepsTotal).toBeNull()
    expect(withNull).toEqual(omitted)
  })

  it('is "nobody said" for a key of nothing but nulls, not a card of empty rows', () => {
    expect(readBuildFacts({ build: { runner: null } })).toBeNull()
    expect(readBuildFacts({ build: {}, image: {} })).toBeNull()
    expect(readBuildFacts({ image: IMAGE, build: { runner: null } })?.run).toBeNull()
    // One field with something in it is still something said.
    expect(readBuildFacts({ build: { runner: 'x', stepsTotal: null } })?.run).toMatchObject({
      runner: 'x',
      stepsTotal: null,
    })
  })

  it('reads only the fields it knows, never a key the agent added', () => {
    const facts = readBuildFacts({ build: { ...BUILD, secrets: { GITHUB_TOKEN: 'ghp_nope' } } })
    expect(JSON.stringify(facts)).not.toContain('ghp_nope')
    expect(facts?.run?.runner).toBe('buildkitd.service')
  })
})

describe('cacheHitRatio', () => {
  it('is the share of steps the cache answered for', () => {
    expect(cacheHitRatio(readBuildFacts({ build: BUILD })?.run ?? null)).toBeCloseTo(7 / 9)
  })

  it('is null rather than zero when nobody counted', () => {
    expect(cacheHitRatio(null)).toBeNull()
    expect(cacheHitRatio(readBuildFacts({ build: { ...BUILD, stepsTotal: 0 } })?.run ?? null)).toBe(
      null,
    )
    expect(
      cacheHitRatio(readBuildFacts({ build: { runner: 'x', stepsTotal: 4 } })?.run ?? null),
    ).toBeNull()
  })
})
