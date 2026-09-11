import { describe, expect, it } from 'vitest'
import {
  buildLogPath,
  buildRequest,
  buildRequestDecoder,
  buildStatusDecoder,
  redactBuildLog,
  tailFromBytes,
} from './builds'
import { DecodeError, decode } from './contract/decode'

const SHA = '159be4d0c2a1f3e4b5d6c7a8e9f0a1b2c3d4e5f6'
const TIP = '2a8f0c1d3e4b5a6978c0d1e2f3a4b5c6d7e8f901'
const ID = '0b6f3c1e-8a2d-4e5f-9c7b-1d2e3f4a5b6c'

// Secret-shaped samples are assembled at runtime so the source never carries a
// string a secret scanner (or the plan's no-secret grep) would flag.
const GHS = `ghs${'_'}${'A1b2C3d4'.repeat(5)}`
const GHP = `ghp${'_'}${'Zz09_yY8'.repeat(4)}`
const PAT = `github${'_'}pat_11ABCDEFG0123456789_abcdefghijklmnopqrstuvwxyz`
const JWT = `eyJ${'hbGciOiJSUzI1NiJ9'}.eyJpc3MiOiIxMjM0NTYifQ.c2lnbmF0dXJlLXNpZw`
const BEGIN = `-----BEGIN ${'RSA PRIVATE KEY'}-----`
const END = `-----END ${'RSA PRIVATE KEY'}-----`
const PEM = `${BEGIN}\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo\n4lgOEePzNm0tRgeLezV6ffAt0gunVTLw\n${END}`

const request = {
  version: 1,
  id: ID,
  app: 'iris',
  sha: SHA,
  repoId: 1_029_384_756,
  strategy: 'auto',
  publish: 'live',
  requestedBy: 'webhook',
  at: '2026-09-11T20:00:00.000Z',
}

const status = {
  version: 1,
  id: ID,
  app: 'iris',
  sha: SHA,
  state: 'building',
  phase: 'building image',
  strategy: 'railpack',
  checks: { ran: ['ci'] },
  timings: { cloning: 1200, detecting: 8400, checking: 61000 },
  updatedAt: '2026-09-11T20:03:00.000Z',
}

describe('build request', () => {
  it('builds the exact contract shape', () => {
    const r = buildRequest({
      id: ID,
      app: 'iris',
      sha: SHA,
      repoId: 1_029_384_756,
      strategy: 'auto',
      publish: 'live',
      requestedBy: 'webhook',
      at: new Date('2026-09-11T20:00:00Z'),
    })
    expect(r).toEqual(request)
  })

  it('decodes a good request', () => {
    expect(decode(buildRequestDecoder, request)).toEqual(request)
  })

  it.each([
    ['a path-traversing id', { id: '../../etc/passwd' }, 'id'],
    ['an id with a dot', { id: 'abc.log' }, 'id'],
    ['an id past 64 chars', { id: 'a'.repeat(65) }, 'id'],
    ['a short sha', { sha: SHA.slice(0, 7) }, 'sha'],
    ['an uppercase sha', { sha: SHA.toUpperCase() }, 'sha'],
    ['a string repoId', { repoId: '1029384756' }, 'repoId'],
    ['a zero repoId', { repoId: 0 }, 'repoId'],
    ['a fractional repoId', { repoId: 1.5 }, 'repoId'],
    ['an unknown strategy', { strategy: 'nixpacks' }, 'strategy'],
    ['an unknown publish mode', { publish: 'preview' }, 'publish'],
    ['an unknown requester', { requestedBy: 'cron' }, 'requestedBy'],
    ['a bad app name', { app: 'Iris/../x' }, 'app'],
  ])('refuses %s', (_label, patch, field) => {
    expect(() => decode(buildRequestDecoder, { ...request, ...patch })).toThrow(DecodeError)
    try {
      decode(buildRequestDecoder, { ...request, ...patch })
    } catch (e) {
      expect((e as DecodeError).path).toBe(field)
    }
  })

  it('refuses another version', () => {
    expect(() => decode(buildRequestDecoder, { ...request, version: 2 })).toThrow(
      /unsupported version 2/,
    )
  })
})

describe('build status', () => {
  it('decodes a running status and fills the optional fields', () => {
    expect(decode(buildStatusDecoder, status)).toEqual({
      ...status,
      tip: null,
      digest: null,
      imageRef: null,
      sizeBytes: null,
      pinned: false,
      candidate: false,
      detected: null,
      checks: { ran: ['ci'], failed: null },
      error: null,
    })
  })

  it('decodes a finished status with every field', () => {
    const done = {
      ...status,
      state: 'succeeded',
      phase: 'done',
      digest: 'sha256:9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0',
      imageRef: `registry.toscanini.me/iris:sha-${SHA}`,
      sizeBytes: 412_345_678,
      pinned: false,
      candidate: true,
      detected: { info: { success: true }, plan: { deploy: {} } },
      checks: { ran: ['generate-routes', 'lint'], failed: 'lint' },
    }
    const d = decode(buildStatusDecoder, done)
    expect(d.state).toBe('succeeded')
    expect(d.candidate).toBe(true)
    expect(d.detected).toEqual(done.detected)
    expect(d.checks).toEqual({ ran: ['generate-routes', 'lint'], failed: 'lint' })
  })

  it('carries the tip of a superseded build', () => {
    const d = decode(buildStatusDecoder, { ...status, state: 'superseded', tip: TIP })
    expect(d.tip).toBe(TIP)
  })

  it('redacts the host error on the way in', () => {
    const d = decode(buildStatusDecoder, {
      ...status,
      state: 'failed',
      error: `fatal: could not read from https://x-access-token:${GHS}@github.com/o/iris`,
    })
    expect(d.error).not.toContain(GHS)
    expect(d.error).toContain('x-access-token:[redacted]')
  })

  it.each([
    ['an unknown state', { state: 'exploded' }],
    ['another version', { version: 2 }],
    ['no version', { version: undefined }],
    ['no updatedAt', { updatedAt: undefined }],
    ['a non-sha tip', { tip: 'main' }],
    ['a non-numeric timing', { timings: { cloning: 'fast' } }],
  ])('refuses %s', (_label, patch) => {
    expect(() => decode(buildStatusDecoder, { ...status, ...patch })).toThrow(DecodeError)
  })
})

describe('buildLogPath', () => {
  const none = () => undefined
  it('defaults to /builds', () => {
    expect(buildLogPath(ID, none)).toBe(`/builds/${ID}.log`)
  })
  it('honours BUILD_LOGS_PATH, trailing slash or not', () => {
    const env = (n: string) => (n === 'BUILD_LOGS_PATH' ? '/tmp/logs/' : undefined)
    expect(buildLogPath(ID, env)).toBe(`/tmp/logs/${ID}.log`)
  })
  it.each(['', '../secret', 'a/b', 'abc.def', '%2e%2e', 'g'.repeat(8), 'a'.repeat(65)])(
    'refuses the id %j',
    (id) => {
      expect(buildLogPath(id, none)).toBeNull()
    },
  )
})

describe('tailFromBytes', () => {
  const bytes = (s: string) => new TextEncoder().encode(s)
  it('keeps everything when the read started at the beginning', () => {
    expect(tailFromBytes(bytes('one\ntwo\n'), false)).toBe('one\ntwo\n')
  })
  it('drops the partial first line of a cut read', () => {
    expect(tailFromBytes(bytes('ne\ntwo\nthree'), true)).toBe('two\nthree')
  })
  it('returns nothing when a cut read holds no whole line', () => {
    expect(tailFromBytes(bytes('partial'), true)).toBe('')
  })
})

describe('redactBuildLog', () => {
  it.each([
    ['an installation token', `token=${GHS} ok`, GHS],
    ['a classic PAT', `using ${GHP}`, GHP],
    ['a fine-grained PAT', `GH_TOKEN=${PAT}`, PAT],
    ['a JWT', `jwt: ${JWT}`, JWT],
  ])('removes %s', (_label, input, secret) => {
    const out = redactBuildLog(input)
    expect(out).not.toContain(secret)
    expect(out).toContain('[redacted]')
  })

  it('removes the credential in an x-access-token URL, keeping the host', () => {
    const out = redactBuildLog(`remote: https://x-access-token:${GHS}@github.com/o/r.git`)
    expect(out).toBe('remote: https://x-access-token:[redacted]@github.com/o/r.git')
  })

  it('removes Authorization header values, keeping the scheme', () => {
    const basic = redactBuildLog('> Authorization: Basic YnVpbGRlcjpodW50ZXIy')
    const bearer = redactBuildLog(`authorization: bearer ${GHS}`)
    expect(basic).toBe('> Authorization: Basic [redacted]')
    expect(bearer).toBe('authorization: bearer [redacted]')
  })

  it('removes a whole multi-line private key block', () => {
    const out = redactBuildLog(`#5 before\n${PEM}\n#5 after`)
    expect(out).toBe('#5 before\n[redacted]\n#5 after')
  })

  it('removes a block whose END has not been written yet', () => {
    const out = redactBuildLog(`#5 before\n${BEGIN}\nMIIEowIBAAKCAQEAu1SU1LfVLPHCozMxH2Mo`)
    expect(out).toBe('#5 before\n[redacted]')
  })

  it('removes the body of a key whose BEGIN fell before the tail', () => {
    const out = redactBuildLog(`4lgOEePzNm0tRgeLezV6ffAt0gunVTLw\n${END}\n#6 next step`)
    expect(out).toBe('[redacted]\n#6 next step')
  })

  it('leaves ordinary build output alone', () => {
    const line = `#7 [build 3/4] RUN pnpm build — ghost_mode=on sha ${SHA} Authorization: none`
    expect(redactBuildLog(line)).toBe(line)
    for (const plain of [
      'listening on http://localhost:3000/healthz',
      'cloning git@github.com:owner/iris.git',
      'fetching https://builder@registry.toscanini.me/v2/',
      'wrote {"auths":{}} to config.json',
      'npm notice _authToken is not set',
    ]) {
      expect(redactBuildLog(plain)).toBe(plain)
    }
  })

  it.each([
    [
      'a password in a URL, keeping the scheme and user',
      'connecting to postgres://iris:s3cr3t-p4ss@pg:5432/iris',
      'connecting to postgres://iris:[redacted]@pg:5432/iris',
    ],
    [
      'a URL password holding an unencoded @',
      'GET https://builder:hunt@er2@registry.example/v2/',
      'GET https://builder:[redacted]@registry.example/v2/',
    ],
    [
      'a URL credential with no user',
      'remote: https://:opaque-pat-value@dev.example/r.git',
      'remote: https://:[redacted]@dev.example/r.git',
    ],
    [
      'a URL-encoded x-access-token',
      'url=https%3A%2F%2Fx-access-token%3Aopaque-value-123%40github.com%2Fo%2Fr',
      'url=https%3A%2F%2Fx-access-token%3A[redacted]%40github.com%2Fo%2Fr',
    ],
    [
      'a URL-encoded x-access-token in lowercase',
      'x-access-token%3aopaque-value-123%40github.com',
      'x-access-token%3A[redacted]%40github.com',
    ],
    [
      'a Docker config auth',
      '{"auths":{"registry.toscanini.me":{"auth":"YnVpbGRlcjpodW50ZXIy"}}}',
      '{"auths":{"registry.toscanini.me":{"auth":"[redacted]"}}}',
    ],
    ['a spaced Docker config auth', '"auth": "YnVpbGRlcjpodW50ZXIy",', '"auth": "[redacted]",'],
    [
      'an Authorization header with the token scheme',
      '> Authorization: token opaque-value-123',
      '> Authorization: token [redacted]',
    ],
    [
      'a JSON Authorization header',
      '{"Authorization": "Bearer opaque-value-123", "Accept": "*/*"}',
      '{"Authorization": "Bearer [redacted]", "Accept": "*/*"}',
    ],
    [
      'an escaped JSON Authorization header',
      String.raw`"{\"Authorization\":\"Basic YnVpbGRlcjpodW50ZXIy\"}"`,
      String.raw`"{\"Authorization\":\"Basic [redacted]\"}"`,
    ],
    [
      'a single-quoted Authorization header',
      "headers = {'authorization': 'token opaque-value-123'}",
      "headers = {'authorization': 'token [redacted]'}",
    ],
    [
      "git's extraheader",
      'git -c http.extraheader="AUTHORIZATION: basic eC1hY2Nlc3M6dG9rZW4=" fetch',
      'git -c http.extraheader="AUTHORIZATION: basic [redacted]" fetch',
    ],
    [
      'an .npmrc _authToken',
      '//registry.npmjs.org/:_authToken=npm_opaqueValue123',
      '//registry.npmjs.org/:_authToken=[redacted]',
    ],
    ['a quoted _authToken', '_authToken = "npm_opaqueValue123"', '_authToken = "[redacted]"'],
  ])('removes %s', (_label, input, expected) => {
    expect(redactBuildLog(input)).toBe(expected)
  })

  it('removes a whole PGP private key block', () => {
    const begin = `-----BEGIN ${'PGP PRIVATE KEY'} BLOCK-----`
    const end = `-----END ${'PGP PRIVATE KEY'} BLOCK-----`
    const block = `${begin}\n\nlQOYBGbcXyIBCADcZ9s0oV1uKq3nR0dS\n=x7Qa\n${end}`
    expect(redactBuildLog(`#5 before\n${block}\n#5 after`)).toBe('#5 before\n[redacted]\n#5 after')
    expect(redactBuildLog(`lQOYBGbcXyIBCADcZ9s0oV1uKq3nR0dS\n${end}\n#6 next`)).toBe(
      '[redacted]\n#6 next',
    )
  })

  describe('terminal escapes', () => {
    const esc = String.fromCharCode(0x1b)
    const body = 'A1b2C3d4'.repeat(5)

    it('strips them before matching, so a colour code cannot split a token', () => {
      const out = redactBuildLog(
        `token=gh${esc}[1ms${'_'}${body.slice(0, 8)}${esc}[0m${body.slice(8)}`,
      )
      expect(out).toBe('token=[redacted]')
    })

    it('strips them from an x-access-token URL and a JWT too', () => {
      const url = redactBuildLog(`https://x-access-${esc}[2mtoken:opaque-value-123@github.com/o/r`)
      expect(url).toBe('https://x-access-token:[redacted]@github.com/o/r')
      const jwt = redactBuildLog(`jwt: ${JWT.slice(0, 10)}${esc}[33m${JWT.slice(10)}${esc}[0m`)
      expect(jwt).toBe('jwt: [redacted]')
    })

    it('leaves no escape behind in ordinary output', () => {
      expect(redactBuildLog(`${esc}[32m#8 DONE 4.2s${esc}[0m`)).toBe('#8 DONE 4.2s')
    })
  })

  describe('on hostile input', () => {
    const MIB = 1 << 20
    const fill = (unit: string) => unit.repeat(Math.ceil(MIB / unit.length)).slice(0, MIB)
    const esc = String.fromCharCode(0x1b)

    it.each([
      ['eyJ repeated: a JWT start every third byte', fill('eyJ')],
      ['a JWT-shaped run with no second dot', `eyJ${fill('a')}.${fill('b')}`],
      ['a URL scheme run', fill('a.')],
      ['a URL secret with no @', `a://b:${fill('c')}`],
      ['repeated Authorization prefixes', fill('authorization: ')],
      ['a header followed by blank space', `authorization:${fill(' ')}x`],
      ['an unterminated escape', `${esc}]${fill('a')}`],
      ['a BEGIN line with no END', `-----BEGIN PRIVATE KEY-----${fill('A')}`],
    ])('redacts a MiB of %s in under 200 ms', (_label, input) => {
      redactBuildLog('warm up the patterns')
      const start = performance.now()
      redactBuildLog(input)
      expect(performance.now() - start).toBeLessThan(200)
    })
  })
})
