import { existsSync, readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  BUILD_REQUEST_MAX_BYTES,
  buildLogPath,
  buildRequest,
  buildRequestBytes,
  buildRequestDecoder,
  buildStatusDecoder,
  isReservedEnvName,
  RAILPACK_KNOB_NAMES,
  RAILPACK_KNOB_PATTERNS,
  RESERVED_ENV_NAMES,
  RESERVED_ENV_PREFIXES,
  railpackValueRefusal,
  redactBuildLog,
  serializeBuildRequest,
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

describe('build request env', () => {
  const buildEnv = {
    placeholders: { MAPBOX_ACCESS_TOKEN: 'pk.placeholder', _UNDERSCORED: '', A: 'x'.repeat(512) },
    railpack: { RAILPACK_PRUNE_DEPS: 'true', RAILPACK_NODE_PLAYWRIGHT_INSTALL: '1' },
  }

  it('leaves buildEnv absent when the request has none', () => {
    const r = decode(buildRequestDecoder, request)
    expect('buildEnv' in r).toBe(false)
    expect(JSON.stringify(r)).toBe(JSON.stringify(request))
  })

  it('carries it through the encoder and the decoder', () => {
    const r = buildRequest({
      id: ID,
      app: 'iris',
      sha: SHA,
      repoId: 1_029_384_756,
      strategy: 'railpack',
      publish: 'candidate',
      requestedBy: 'sweep',
      at: new Date('2026-09-11T20:00:00Z'),
      buildEnv,
    })
    expect(r.version).toBe(1)
    expect(r.buildEnv).toEqual(buildEnv)
    expect(decode(buildRequestDecoder, JSON.parse(JSON.stringify(r)))).toEqual(r)
  })

  it('accepts empty maps', () => {
    const env = { placeholders: {}, railpack: {} }
    expect(decode(buildRequestDecoder, { ...request, buildEnv: env }).buildEnv).toEqual(env)
  })

  const P = 'buildEnv.placeholders'
  const R = 'buildEnv.railpack'
  it.each([
    ['a lowercase placeholder', { placeholders: { auth_secret: 'x' }, railpack: {} }, P],
    ['a placeholder starting with a digit', { placeholders: { '1X': 'x' }, railpack: {} }, P],
    [
      'a placeholder past 64 chars',
      { placeholders: { [`A${'B'.repeat(64)}`]: 'x' }, railpack: {} },
      P,
    ],
    ['a placeholder with a dash', { placeholders: { 'AUTH-SECRET': 'x' }, railpack: {} }, P],
    ['a __proto__ key', { placeholders: JSON.parse('{"__proto__":"x"}'), railpack: {} }, P],
    [
      'a railpack key without the prefix',
      { placeholders: {}, railpack: { NODE_VERSION: '24' } },
      R,
    ],
    ['a bare RAILPACK_', { placeholders: {}, railpack: { RAILPACK_: '1' } }, R],
    [
      'a Railpack name past 64 chars',
      { placeholders: {}, railpack: { [`RAILPACK_${'A'.repeat(56)}`]: '1' } },
      R,
    ],
    ['a reserved placeholder', { placeholders: { NPM_CONFIG_REGISTRY: 'x' }, railpack: {} }, P],
    ['a placeholder under NODE_', { placeholders: { NODE_ENV: 'production' }, railpack: {} }, P],
    ['a Railpack command', { placeholders: {}, railpack: { RAILPACK_START_CMD: 'x' } }, R],
    [
      'a Railpack switch this box does not pass on',
      { placeholders: {}, railpack: { RAILPACK_PACKAGES: 'node' } },
      R,
    ],
    [
      'more than 40 names in one map',
      {
        placeholders: Object.fromEntries(
          Array.from({ length: 41 }, (_, i) => [`K${String(i)}`, 'v']),
        ),
        railpack: {},
      },
      P,
    ],
    ['a non-string value', { placeholders: { A: 1 }, railpack: {} }, `${P}.A`],
    ['a value past 512 chars', { placeholders: { A: 'x'.repeat(513) }, railpack: {} }, `${P}.A`],
    [
      'a NUL in a value',
      { placeholders: {}, railpack: { RAILPACK_PRUNE_DEPS: 'a\0b' } },
      `${R}.RAILPACK_PRUNE_DEPS`,
    ],
    ['a line feed in a value', { placeholders: { A: 'a\nB=b' }, railpack: {} }, `${P}.A`],
    ['a carriage return in a value', { placeholders: { A: 'a\rb' }, railpack: {} }, `${P}.A`],
    [
      'a Railpack value Railpack would not read as meant',
      { placeholders: {}, railpack: { RAILPACK_SPA_OUTPUT_DIR: '../..' } },
      `${R}.RAILPACK_SPA_OUTPUT_DIR`,
    ],
    ['a missing half', { placeholders: {} }, R],
    ['an array', [], 'buildEnv'],
  ])('refuses %s', (_label, value, path) => {
    let caught: unknown = null
    try {
      decode(buildRequestDecoder, { ...request, buildEnv: value })
    } catch (e) {
      caught = e
    }
    expect(caught).toBeInstanceOf(DecodeError)
    expect((caught as DecodeError).path).toBe(path)
  })

  it('never quotes a value in the error', () => {
    const secretish = 'do-not-echo-this-value'
    for (const env of [
      { placeholders: { A: `${secretish}${'x'.repeat(600)}` }, railpack: {} },
      { placeholders: { lower: secretish }, railpack: {} },
    ]) {
      let caught: unknown = null
      try {
        decode(buildRequestDecoder, { ...request, buildEnv: env })
      } catch (e) {
        caught = e
      }
      expect(caught).toBeInstanceOf(DecodeError)
      expect((caught as Error).message).not.toContain(secretish)
    }
  })
})

describe('the build env rules, identical in host/build.sh', () => {
  // host/build.sh's RESERVED_ENV_RE and RAILPACK_KNOBS as of 2026-09-12.
  //
  // Where the host file is visible — on the box, with DAEDALUS_HOST_BUILD_SH
  // naming it, or at s2-server's own path — the tests read it, and it must equal
  // this copy. Where it is not (this public repo's CI), the copy stands in. The
  // copy therefore cannot go stale without a run on the box failing, and the
  // engine's lists are held to the host's text in both places.
  const HOST_RESERVED_ENV_RE =
    '^(PATH|HOME|SHELL|USER|LOGNAME|PWD|OLDPWD|IFS|ENV|BASH|BASH_ENV|BASHOPTS|SHELLOPTS|CDPATH|GLOBIGNORE|PS4|PROMPT_COMMAND|UID|EUID|PPID|SHLVL|TMPDIR|TZ|LANG|LANGUAGE|TERM|HOSTNAME|GCONV_PATH|GLIBC_TUNABLES|LOCPATH|GITHUB_TOKEN|DAEDALUS_TOKEN_FILE|NO_PROXY|HTTP_PROXY|HTTPS_PROXY|ALL_PROXY|FTP_PROXY|GODEBUG|GOFLAGS|GOTRACEBACK|GOENV|GOROOT|GOPATH|GOBIN|GOCACHE|GOCACHEPROG|GOMODCACHE|GOTMPDIR|GOWORK|GOPROXY|GONOPROXY|GOPRIVATE|GOSUMDB|GONOSUMDB|GONOSUMCHECK|GOINSECURE|GOVCS|GOAUTH|GOTOOLCHAIN|GOEXPERIMENT|GO111MODULE|RUSTDOC|RUSTFLAGS|RUSTDOCFLAGS|RUBYOPT|RUBYLIB|GEM_PATH|GEM_HOME|PERLLIB|JAVA_TOOL_OPTIONS|JDK_JAVA_OPTIONS|_JAVA_OPTIONS)$|^(LD_|BASH_FUNC_|GIT_|BUILDKIT_|BUILDCTL_|DOCKER_|MISE_|RAILPACK_|XDG_|LC_|SSL_|NIX_SSL_|CURL_|SYSTEMD_|NPM_CONFIG_|PNPM_|COREPACK_|YARN_|BUN_|NODE_|CGO_|PIP_|UV_|PYTHON|CARGO_|RUSTUP_|RUSTC|BUNDLE_|PERL5)'
  const APT = '[a-z0-9][a-z0-9+.-]*(?:=[A-Za-z0-9.+~:-]+)?'
  const FLAG = '^(?:true|false|1|0)$'
  const HOST_RAILPACK_KNOBS: Record<string, string> = {
    RAILPACK_PRUNE_DEPS: FLAG,
    RAILPACK_NODE_PLAYWRIGHT_INSTALL: FLAG,
    RAILPACK_NO_SPA: FLAG,
    RAILPACK_DISABLE_CACHES: '^(?:\\*|[A-Za-z0-9_.:-]+(?: [A-Za-z0-9_.:-]+)*)$',
    RAILPACK_SPA_OUTPUT_DIR: '^(?!/)(?!(?:.*/)?\\.\\.(?:/|$))[A-Za-z0-9._/-]{1,200}$',
    RAILPACK_NODE_VERSION: '^[0-9]{1,3}(?:\\.[0-9]{1,4}){0,2}$',
    RAILPACK_BUILD_APT_PACKAGES: `^${APT}(?: ${APT})*$`,
    RAILPACK_DEPLOY_APT_PACKAGES: `^${APT}(?: ${APT})*$`,
  }

  const hostPath = process.env.DAEDALUS_HOST_BUILD_SH ?? '/etc/nixos/stacks/daedalus/host/build.sh'
  // A path named on purpose must exist; the default path is simply absent off the box.
  const hostText =
    process.env.DAEDALUS_HOST_BUILD_SH !== undefined || existsSync(hostPath)
      ? readFileSync(hostPath, 'utf8')
      : null

  /** A `NAME='…'` assignment's value, which build.sh keeps in exactly that form. */
  function assignment(text: string, name: string): string {
    const m = new RegExp(`^${name}='([^']*)'$`, 'm').exec(text)
    if (m?.[1] === undefined) throw new Error(`host/build.sh has no ${name}='…' line`)
    return m[1]
  }

  const hostReserved =
    hostText === null ? HOST_RESERVED_ENV_RE : assignment(hostText, 'RESERVED_ENV_RE')
  const hostKnobs: Record<string, string> =
    hostText === null ? HOST_RAILPACK_KNOBS : JSON.parse(assignment(hostText, 'RAILPACK_KNOBS'))

  it.runIf(hostText !== null)('are read from the host file, which matches the copy here', () => {
    expect(hostReserved).toBe(HOST_RESERVED_ENV_RE)
    expect(hostKnobs).toEqual(HOST_RAILPACK_KNOBS)
  })

  it("build the host's reserved-name pattern from the engine's lists, in order", () => {
    expect(`^(${RESERVED_ENV_NAMES.join('|')})$|^(${RESERVED_ENV_PREFIXES.join('|')})`).toBe(
      hostReserved,
    )
  })

  it('repeat no name a prefix already covers', () => {
    for (const name of RESERVED_ENV_NAMES) {
      expect(RESERVED_ENV_PREFIXES.filter((p) => name.startsWith(p))).toEqual([])
    }
  })

  it("pass on exactly the host's Railpack switches, with the host's value patterns", () => {
    expect(RAILPACK_KNOB_PATTERNS).toEqual(hostKnobs)
    expect(Object.keys(hostKnobs)).toEqual([...RAILPACK_KNOB_NAMES])
  })

  it('refuse the same names on both sides', () => {
    const host = new RegExp(hostReserved)
    const refused = [
      'PATH',
      'LD_PRELOAD',
      'GIT_DIR',
      'RAILPACK_X',
      'SYSTEMD_EXEC_PID',
      'NPM_CONFIG_REGISTRY',
      'NODE_OPTIONS',
      'BASH_ENV',
      'PROMPT_COMMAND',
      'GCONV_PATH',
      'GLIBC_TUNABLES',
      'LOCPATH',
      'GOPROXY',
      'GONOSUMDB',
      'GOPRIVATE',
      'GOTOOLCHAIN',
      'GOEXPERIMENT',
      'GOENV',
      'GOCACHEPROG',
      'CGO_LDFLAGS',
      'PIP_INDEX_URL',
      'UV_INDEX_URL',
      'PYTHONPATH',
      'PYTHONSTARTUP',
      'PYTHON_GIL',
      'CARGO_HOME',
      'RUSTUP_TOOLCHAIN',
      'RUSTC_WRAPPER',
      'RUSTFLAGS',
      'BUNDLE_GEMFILE',
      'PERL5LIB',
      'PERL5OPT',
      'PERLLIB',
      'RUBYOPT',
      'GEM_HOME',
      'JAVA_TOOL_OPTIONS',
      '_JAVA_OPTIONS',
    ]
    for (const name of refused) {
      expect([name, isReservedEnvName(name)]).toEqual([name, true])
      expect([name, host.test(name)]).toEqual([name, true])
    }
    for (const name of [
      'PATHS',
      'MY_PATH',
      'GOOGLE_ANALYTICS_ID',
      'GOLD_API_KEY',
      'PIPEDREAM_KEY',
    ]) {
      expect([name, isReservedEnvName(name)]).toEqual([name, false])
      expect([name, host.test(name)]).toEqual([name, false])
    }
  })

  // Every build-time placeholder the seven apps declare (the plan's railpack.json table).
  const APP_PLACEHOLDERS = [
    'DATABASE_URL',
    'AUTH_SECRET',
    'MAPBOX_ACCESS_TOKEN',
    'GOOGLE_MAPS_API_KEY',
    'GOOGLE_MAPS_MAP_ID',
    'AVIATIONSTACK_API_KEY',
    'GOOGLE_TIME_ZONE_API_KEY',
    'LITELLM_BASE_URL',
    'LITELLM_API_KEY',
    'LITELLM_MODEL',
  ]

  it("let every app's real placeholder names through on both sides", () => {
    const host = new RegExp(hostReserved)
    for (const name of APP_PLACEHOLDERS) {
      expect([name, isReservedEnvName(name)]).toEqual([name, false])
      expect([name, host.test(name)]).toEqual([name, false])
    }
    const placeholders = Object.fromEntries(APP_PLACEHOLDERS.map((n) => [n, 'placeholder']))
    const decoded = decode(buildRequestDecoder, {
      ...request,
      buildEnv: { placeholders, railpack: {} },
    })
    expect(Object.keys(decoded.buildEnv?.placeholders ?? {})).toEqual(APP_PLACEHOLDERS)
  })

  it('give each Railpack value the same verdict on both sides', () => {
    const cases: [string, string, boolean][] = [
      ['RAILPACK_PRUNE_DEPS', 'true', true],
      ['RAILPACK_PRUNE_DEPS', 'yes', false],
      ['RAILPACK_DISABLE_CACHES', '*', true],
      ['RAILPACK_DISABLE_CACHES', 'pnpm-install node-modules', true],
      ['RAILPACK_DISABLE_CACHES', '* x', false],
      ['RAILPACK_SPA_OUTPUT_DIR', 'dist', true],
      ['RAILPACK_SPA_OUTPUT_DIR', 'dist/client', true],
      ['RAILPACK_SPA_OUTPUT_DIR', './dist', true],
      ['RAILPACK_SPA_OUTPUT_DIR', 'a..b', true],
      ['RAILPACK_SPA_OUTPUT_DIR', '...', true],
      ['RAILPACK_SPA_OUTPUT_DIR', '..', false],
      ['RAILPACK_SPA_OUTPUT_DIR', '../etc', false],
      ['RAILPACK_SPA_OUTPUT_DIR', 'dist/../..', false],
      ['RAILPACK_SPA_OUTPUT_DIR', 'x/..', false],
      ['RAILPACK_SPA_OUTPUT_DIR', '/etc', false],
      ['RAILPACK_SPA_OUTPUT_DIR', 'dist dir', false],
      ['RAILPACK_SPA_OUTPUT_DIR', 'd'.repeat(201), false],
      ['RAILPACK_NODE_VERSION', '24', true],
      ['RAILPACK_NODE_VERSION', '24.18.1', true],
      ['RAILPACK_NODE_VERSION', '２４', false],
      ['RAILPACK_NODE_VERSION', '24.18.1.1', false],
      ['RAILPACK_NODE_VERSION', 'path:/tmp/node', false],
      ['RAILPACK_DEPLOY_APT_PACKAGES', 'ffmpeg chromium fonts-liberation', true],
      ['RAILPACK_DEPLOY_APT_PACKAGES', 'libc6=2.41-12', true],
      ['RAILPACK_DEPLOY_APT_PACKAGES', 'ffmpeg  git', false],
      ['RAILPACK_DEPLOY_APT_PACKAGES', 'ffmpeg; curl x|sh', false],
      ['RAILPACK_BUILD_APT_PACKAGES', '$(id)', false],
    ]
    for (const [name, value, ok] of cases) {
      expect([name, value, railpackValueRefusal(name, value) === null]).toEqual([name, value, ok])
      const pattern = hostKnobs[name]
      expect(pattern).toBeDefined()
      expect([name, value, new RegExp(pattern ?? '').test(value)]).toEqual([name, value, ok])
    }
  })
})

describe('Railpack switches', () => {
  it('are exactly the tuning switches, no command among them', () => {
    expect([...RAILPACK_KNOB_NAMES].sort()).toEqual([
      'RAILPACK_BUILD_APT_PACKAGES',
      'RAILPACK_DEPLOY_APT_PACKAGES',
      'RAILPACK_DISABLE_CACHES',
      'RAILPACK_NODE_PLAYWRIGHT_INSTALL',
      'RAILPACK_NODE_VERSION',
      'RAILPACK_NO_SPA',
      'RAILPACK_PRUNE_DEPS',
      'RAILPACK_SPA_OUTPUT_DIR',
    ])
    for (const k of RAILPACK_KNOB_NAMES) expect(k).not.toMatch(/_CMD$/)
  })

  it('decode with the values Railpack reads', () => {
    const railpack = {
      RAILPACK_PRUNE_DEPS: 'true',
      RAILPACK_DEPLOY_APT_PACKAGES: 'ffmpeg chromium',
      RAILPACK_SPA_OUTPUT_DIR: 'dist',
      RAILPACK_NODE_VERSION: '24',
      RAILPACK_DISABLE_CACHES: '*',
    }
    const decoded = decode(buildRequestDecoder, {
      ...request,
      buildEnv: { placeholders: {}, railpack },
    })
    expect(decoded.buildEnv?.railpack).toEqual(railpack)
  })
})

describe('request size', () => {
  it('measures the exact bytes the bridge writes, under the host ceiling', () => {
    const r = buildRequest({
      id: ID,
      app: 'iris',
      sha: SHA,
      repoId: 1,
      strategy: 'auto',
      publish: 'live',
      requestedBy: 'webhook',
      at: new Date('2026-09-11T20:00:00Z'),
      buildEnv: { placeholders: { A: '€' }, railpack: {} },
    })
    const text = serializeBuildRequest(r)
    expect(text).toBe(`${JSON.stringify(r, null, 2)}\n`)
    expect(buildRequestBytes(r)).toBe(Buffer.byteLength(text, 'utf8'))
    expect(buildRequestBytes(r)).toBeGreaterThan(text.length)
    expect(BUILD_REQUEST_MAX_BYTES).toBe(60 * 1024)
    expect(BUILD_REQUEST_MAX_BYTES).toBeLessThan(65_536)
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
      repo: null,
      image: null,
      build: null,
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
