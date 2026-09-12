import { describe, expect, it } from 'vitest'
import { cacheHitRatio, pullBytes, readBuildFacts } from './build-facts'

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
  secretsHash: 'b3a1c2d4e5f60718',
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
        secretsHash: 'b3a1c2d4e5f60718',
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
    // The contract is "omit the key"; agents have published `secretsHash: null`
    // for an app with no build secrets. Both must read the same way.
    const withNull = readBuildFacts({ build: { ...BUILD, secretsHash: null } })?.run
    const omitted = readBuildFacts({
      build: {
        runner: BUILD.runner,
        cacheImported: true,
        cacheExported: false,
        stepsCached: 7,
        stepsTotal: 9,
      },
    })?.run
    expect(withNull?.secretsHash).toBeNull()
    expect(withNull).toEqual(omitted)
  })

  it('is "nobody said" for a key of nothing but nulls, not a card of empty rows', () => {
    expect(readBuildFacts({ build: { secretsHash: null } })).toBeNull()
    expect(readBuildFacts({ build: {}, image: {} })).toBeNull()
    expect(readBuildFacts({ image: IMAGE, build: { secretsHash: null } })?.run).toBeNull()
    // One field with something in it is still something said.
    expect(readBuildFacts({ build: { runner: 'x', secretsHash: null } })?.run).toMatchObject({
      runner: 'x',
      secretsHash: null,
    })
  })

  it('never reads a secret value, only the fingerprint the agent sends', () => {
    const facts = readBuildFacts({ build: { ...BUILD, secrets: { GITHUB_TOKEN: 'ghp_nope' } } })
    expect(JSON.stringify(facts)).not.toContain('ghp_nope')
    expect(facts?.run?.secretsHash).toBe('b3a1c2d4e5f60718')
  })
})

describe('pullBytes', () => {
  it('is the config plus every compressed layer', () => {
    expect(pullBytes(readBuildFacts({ image: IMAGE })?.image ?? null)).toBe(6_500)
  })

  it('is null unless the agent listed every part', () => {
    expect(pullBytes(null)).toBeNull()
    expect(
      pullBytes(readBuildFacts({ image: { ...IMAGE, configSize: null } })?.image ?? null),
    ).toBe(null)
    expect(pullBytes(readBuildFacts({ image: { ...IMAGE, layerSizes: [] } })?.image ?? null)).toBe(
      null,
    )
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
