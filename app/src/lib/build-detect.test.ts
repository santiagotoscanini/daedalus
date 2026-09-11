import { describe, expect, it } from 'vitest'
import {
  type Detection,
  detectionFromStatus,
  detectionWarnings,
  type RepoFacts,
  readDetection,
} from './build-detect'

// Fixtures follow Railpack v0.39.0 exactly where the source pins the shape:
//  - info: core/core.go BuildResult (json tags), written by cli/prepare.go
//    writeInfoFile with `plan` dropped; logger.Msg has no json tags, so log
//    entries are { Level, Msg, DocsPath }; metadata keys from
//    core/providers/node/node.go SetNodeMetadata and core.go ("providers");
//    version sources from core/resolver, core/providers/node and
//    core/generate (mise's source types: "idiomatic-version-file" etc.).
//  - plans: excerpts of core/__snapshots__/TestGenerateBuildPlanForExamples_*
//    (node-pnpm-11-engines, node-puppeteer, node-vite-react), verbatim.
// A resolvedVersion for a range (11.5.x) depends on the day mise resolves it,
// and the suggestion/deprecation log messages are invented; both illustrative.

/** examples/node-pnpm-11-engines: engines { node: "24.16.0", pnpm: "11.5.x" }. */
const PNPM_ENGINES_INFO = {
  railpackVersion: '0.39.0',
  resolvedPackages: {
    node: {
      name: 'node',
      requestedVersion: '24.16.0',
      resolvedVersion: '24.16.0',
      source: 'package.json > engines > node',
    },
    pnpm: {
      name: 'pnpm',
      requestedVersion: '11.5.x',
      resolvedVersion: '11.5.2',
      source: 'package.json > engines > pnpm',
    },
  },
  metadata: { nodePackageManager: 'pnpm', nodeRuntime: 'node', providers: 'node' },
  detectedProviders: ['node'],
  logs: [{ Level: 'info', Msg: 'Detected Node', DocsPath: '' }],
  success: true,
}

const PNPM_ENGINES_PLAN = {
  deploy: {
    base: { step: 'packages:apt:runtime' },
    startCommand: 'pnpm run start',
    variables: { CI: 'true', NODE_ENV: 'production', RAILPACK_VERSION: 'dev' },
  },
  steps: [
    {
      commands: [
        { path: '/mise/shims' },
        { cmd: 'mise install', customName: 'install mise packages: node, pnpm' },
      ],
      name: 'packages:mise',
    },
    {
      caches: ['apt', 'apt-lists'],
      commands: [
        {
          cmd: "sh -c 'apt-get update && apt-get install -y libatomic1'",
          customName: 'install apt packages: libatomic1',
        },
      ],
      inputs: [{ image: 'ghcr.io/railwayapp/railpack-runtime:mise-2026.8.16' }],
      name: 'packages:apt:runtime',
    },
  ],
}

/** An iris-shaped app after its railpack.json: exact pins, `node start.mjs`. */
const IRIS_INFO = {
  railpackVersion: '0.39.0',
  resolvedPackages: {
    node: {
      name: 'node',
      requestedVersion: '24.18.1',
      resolvedVersion: '24.18.1',
      source: 'custom config',
    },
    pnpm: {
      name: 'pnpm',
      requestedVersion: '11.18.0',
      resolvedVersion: '11.18.0',
      source: 'idiomatic-version-file',
    },
  },
  metadata: { nodePackageManager: 'pnpm', nodeRuntime: 'tanstack-start', providers: 'node' },
  detectedProviders: ['node'],
  logs: [
    { Level: 'info', Msg: 'Using config file `railpack.json`', DocsPath: '' },
    {
      Level: 'warn',
      Msg: 'The config file format is not yet finalized and subject to change.',
      DocsPath: '',
    },
    { Level: 'info', Msg: 'Detected Node', DocsPath: '' },
  ],
  success: true,
}

/** The same app with both versions pinned in .tool-versions, and no advice logged. */
const PINNED_INFO = {
  ...IRIS_INFO,
  resolvedPackages: {
    node: { ...IRIS_INFO.resolvedPackages.node, source: '.tool-versions' },
    pnpm: { ...IRIS_INFO.resolvedPackages.pnpm, source: '.tool-versions' },
  },
  logs: [{ Level: 'info', Msg: 'Detected Node', DocsPath: '' }],
}

const IRIS_PLAN = {
  deploy: { base: { step: 'packages:apt:runtime' }, startCommand: 'node start.mjs' },
  steps: [PNPM_ENGINES_PLAN.steps[1]],
}

const PUPPETEER_APT =
  'ca-certificates fonts-liberation libasound2 libatk1.0-0 libatomic1 libc6 libcairo2 libcups2 libdbus-1-3 libexpat1 libfontconfig1 libgbm1 libgcc1 libgdk-pixbuf-2.0-0 libglib2.0-0 libgtk-3-0 libnspr4 libnss3 libpango-1.0-0 libpangocairo-1.0-0 libstdc++6 libx11-6 libx11-xcb1 libxcb1 libxcomposite1 libxcursor1 libxdamage1 libxext6 libxfixes3 libxi6 libxrandr2 libxrender1 libxss1 libxtst6 lsb-release wget xdg-utils xvfb'

const PUPPETEER_PLAN = {
  deploy: { base: { step: 'packages:apt:runtime' }, startCommand: 'node index.js' },
  steps: [
    {
      caches: ['apt', 'apt-lists'],
      commands: [
        {
          cmd: `sh -c 'apt-get update && apt-get install -y ${PUPPETEER_APT}'`,
          customName: `install apt packages: ${PUPPETEER_APT}`,
        },
      ],
      name: 'packages:apt:runtime',
    },
  ],
}

const VITE_SPA_INFO = {
  ...PNPM_ENGINES_INFO,
  metadata: {
    nodePackageManager: 'npm',
    nodeRuntime: 'vite',
    nodeIsSPA: 'true',
    providers: 'node',
  },
}
const VITE_SPA_PLAN = {
  deploy: { startCommand: 'caddy run --config /Caddyfile --adapter caddyfile 2>&1' },
}

const detect = (info: unknown, plan?: unknown): Detection => {
  const d = readDetection(info, plan)
  if (d === null) throw new Error('expected a detection')
  return d
}

describe('readDetection', () => {
  it('reads a pnpm engines app', () => {
    expect(detect(PNPM_ENGINES_INFO, PNPM_ENGINES_PLAN)).toEqual({
      provider: 'node',
      framework: 'node',
      node: { version: '24.16.0', requested: '24.16.0', source: 'package.json > engines > node' },
      pnpm: { version: '11.5.2', requested: '11.5.x', source: 'package.json > engines > pnpm' },
      startCommand: 'pnpm run start',
      aptPackages: ['libatomic1'],
      spa: false,
      railpackVersion: '0.39.0',
      success: true,
      logs: [{ level: 'info', message: 'Detected Node' }],
    })
  })

  it('reads a TanStack Start app pinned by railpack.json', () => {
    const d = detect(IRIS_INFO, IRIS_PLAN)
    expect(d.framework).toBe('tanstack-start')
    expect(d.node).toEqual({ version: '24.18.1', requested: '24.18.1', source: 'custom config' })
    expect(d.pnpm?.source).toBe('idiomatic-version-file')
    expect(d.startCommand).toBe('node start.mjs')
    expect(d.logs.map((l) => l.level)).toEqual(['info', 'warn', 'info'])
  })

  it('reads the runtime apt packages from the packages:apt:runtime step', () => {
    expect(detect(PNPM_ENGINES_INFO, PUPPETEER_PLAN).aptPackages).toContain('libnss3')
    const cmdOnly = {
      steps: [
        {
          name: 'packages:apt:runtime',
          commands: [
            { cmd: "sh -c 'apt-get update && apt-get install -y chromium fonts-liberation'" },
          ],
        },
      ],
    }
    expect(detect(PNPM_ENGINES_INFO, cmdOnly).aptPackages).toEqual(['chromium', 'fonts-liberation'])
  })

  it('ignores build-time apt steps', () => {
    const plan = {
      steps: [
        {
          name: 'packages:apt:build',
          commands: [{ customName: 'install apt packages: build-essential' }],
        },
      ],
    }
    expect(detect(PNPM_ENGINES_INFO, plan).aptPackages).toEqual([])
  })

  it('reads the SPA flag from string metadata', () => {
    const d = detect(VITE_SPA_INFO, VITE_SPA_PLAN)
    expect(d.spa).toBe(true)
    expect(d.framework).toBe('vite')
  })

  it('decodes a failed prepare, whose info holds only success and logs', () => {
    const d = detect({
      success: false,
      logs: [{ Level: 'error', Msg: 'no start command was found', DocsPath: '' }],
    })
    expect(d).toMatchObject({
      success: false,
      provider: null,
      node: null,
      startCommand: null,
      aptPackages: [],
      logs: [{ level: 'error', message: 'no start command was found' }],
    })
  })

  it('accepts lowercase log keys too', () => {
    expect(detect({ success: true, logs: [{ level: 'warn', msg: 'x' }] }).logs).toEqual([
      { level: 'warn', message: 'x' },
    ])
  })

  it('redacts log messages', () => {
    const token = `ghs${'_'}${'A1b2C3d4'.repeat(5)}`
    const d = detect({ success: false, logs: [{ Level: 'error', Msg: `fetch ${token} failed` }] })
    expect(d.logs[0]?.message).not.toContain(token)
  })

  it('takes the provider from detectedProviders[0], never from metadata', () => {
    const both = { success: true, metadata: { providers: 'node' }, detectedProviders: ['python'] }
    expect(detect(both).provider).toBe('python')
    expect(detect({ success: true, metadata: { providers: 'node' } }).provider).toBeNull()
  })

  it('blanks mistyped fields instead of failing the whole detection', () => {
    const d = detect({
      success: true,
      railpackVersion: 39,
      metadata: 'node',
      resolvedPackages: { node: 'lts' },
      detectedProviders: [7],
      logs: 'none',
    })
    expect(d).toMatchObject({ railpackVersion: null, provider: null, node: null, logs: [] })
  })

  it.each([[null], ['info'], [[]], [{}], [{ unrelated: true }]])('returns null for %j', (info) => {
    expect(readDetection(info)).toBeNull()
  })
})

describe('detectionFromStatus', () => {
  it('reads the { info, plan } pair', () => {
    expect(detectionFromStatus({ info: IRIS_INFO, plan: IRIS_PLAN })?.startCommand).toBe(
      'node start.mjs',
    )
  })
  it('reads a bare info document', () => {
    expect(detectionFromStatus(IRIS_INFO)?.framework).toBe('tanstack-start')
  })
})

const IRIS_REPO: RepoFacts = {
  hasStartMjs: true,
  hasDatabase: true,
  dependencies: ['@tanstack/react-start', 'drizzle-orm', 'postgres'],
  productionDependencies: ['@tanstack/react-start', 'drizzle-orm', 'postgres'],
  packageManager: 'pnpm@11.18.0+sha512.8f7e6d5c4b3a29180706f5e4d3c2b1a0',
  allowBuilds: [],
  railpackEnv: {},
  registeredAsServer: true,
  scripts: { start: 'node .output/server/index.mjs' },
}

const codes = (d: Detection, repo: RepoFacts) => detectionWarnings(d, repo).map((w) => w.code)

describe('detectionWarnings', () => {
  it('has nothing to say about an app pinned in .tool-versions', () => {
    expect(detectionWarnings(detect(PINNED_INFO, IRIS_PLAN), IRIS_REPO)).toEqual([])
  })

  describe('start command bypasses start.mjs', () => {
    const zeroConfig = { ...IRIS_PLAN, deploy: { startCommand: 'pnpm run start' } }

    it('warns when the start script skips start.mjs on an app with a database', () => {
      const w = detectionWarnings(detect(PINNED_INFO, zeroConfig), IRIS_REPO)
      expect(w.map((x) => x.code)).toEqual(['start-bypasses-migrations'])
      expect(w[0]?.message).toMatch(/migrations would not run/)
    })

    it('accepts a start script that runs start.mjs', () => {
      const repo = { ...IRIS_REPO, scripts: { start: 'node start.mjs' } }
      expect(codes(detect(PINNED_INFO, zeroConfig), repo)).toEqual([])
    })

    it('warns when no start command was found at all', () => {
      expect(codes(detect(PINNED_INFO, {}), IRIS_REPO)).toEqual(['start-bypasses-migrations'])
    })

    it('says nothing for an app without a database or without start.mjs', () => {
      const d = detect(PINNED_INFO, zeroConfig)
      expect(codes(d, { ...IRIS_REPO, hasDatabase: false })).toEqual([])
      expect(codes(d, { ...IRIS_REPO, hasStartMjs: false })).toEqual([])
    })
  })

  describe('browsers', () => {
    const withDeps = (deps: string[], over: Partial<RepoFacts> = {}): RepoFacts => ({
      ...IRIS_REPO,
      dependencies: [...IRIS_REPO.dependencies, ...deps],
      ...over,
    })
    const puppeteerPlan = { ...PUPPETEER_PLAN, deploy: IRIS_PLAN.deploy }
    const chromiumPlan = {
      deploy: IRIS_PLAN.deploy,
      steps: [
        {
          name: 'packages:apt:runtime',
          commands: [{ customName: 'install apt packages: libatomic1 chromium fonts-liberation' }],
        },
      ],
    }

    it('warns for puppeteer-core without a chromium runtime package — Railpack ignores it', () => {
      const repo = withDeps(['puppeteer-core'])
      expect(codes(detect(PINNED_INFO, puppeteerPlan), repo)).toEqual([
        'puppeteer-core-without-chromium',
      ])
      expect(codes(detect(PINNED_INFO, chromiumPlan), repo)).toEqual([])
    })

    it('warns for puppeteer when pnpm-workspace.yaml does not allow its build', () => {
      const d = detect(PINNED_INFO, puppeteerPlan)
      expect(codes(d, withDeps(['puppeteer']))).toEqual(['puppeteer-build-not-allowed'])
      expect(codes(d, withDeps(['puppeteer'], { allowBuilds: ['esbuild', 'puppeteer'] }))).toEqual(
        [],
      )
    })

    it('does not hold puppeteer to allowBuilds in an app that does not use pnpm', () => {
      const npm = { ...PINNED_INFO, resolvedPackages: { node: PINNED_INFO.resolvedPackages.node } }
      const repo = withDeps(['puppeteer'], { packageManager: 'npm@11.0.0' })
      expect(codes(detect(npm, puppeteerPlan), repo)).toEqual([])
    })

    it('warns for a production playwright without RAILPACK_NODE_PLAYWRIGHT_INSTALL', () => {
      const repo = withDeps(['playwright'], { productionDependencies: ['playwright'] })
      const d = detect(PINNED_INFO, IRIS_PLAN)
      expect(codes(d, repo)).toEqual(['playwright-without-install'])
      expect(
        codes(d, { ...repo, railpackEnv: { RAILPACK_NODE_PLAYWRIGHT_INSTALL: 'true' } }),
      ).toEqual([])
      expect(codes(d, { ...repo, railpackEnv: { RAILPACK_NODE_PLAYWRIGHT_INSTALL: ' ' } })).toEqual(
        ['playwright-without-install'],
      )
    })

    it('says nothing about playwright as a dev dependency (end-to-end tests)', () => {
      expect(codes(detect(PINNED_INFO, IRIS_PLAN), withDeps(['playwright']))).toEqual([])
    })
  })

  describe('versions not pinned in .tool-versions', () => {
    const withSources = (node: string, pnpm: string) => ({
      ...PINNED_INFO,
      resolvedPackages: {
        node: { ...PINNED_INFO.resolvedPackages.node, source: node },
        pnpm: { ...PINNED_INFO.resolvedPackages.pnpm, source: pnpm },
      },
    })

    it.each(['.tool-versions', '/app/.tool-versions', 'tool-versions', '.TOOL-VERSIONS'])(
      "accepts %j as the app's .tool-versions",
      (source) => {
        expect(codes(detect(withSources(source, source), IRIS_PLAN), IRIS_REPO)).toEqual([])
      },
    )

    it.each([
      'custom config',
      'package.json > engines > node',
      'railpack default',
      'idiomatic-version-file',
      'mise.toml',
    ])('warns when Node comes from %j', (source) => {
      const w = detectionWarnings(
        detect(withSources(source, '.tool-versions'), IRIS_PLAN),
        IRIS_REPO,
      )
      expect(w.map((x) => x.code)).toEqual(['version-not-from-tool-versions'])
      expect(w[0]?.message).toContain('Node 24.18.1')
      expect(w[0]?.message).toContain(source)
    })

    it('warns for pnpm on its own', () => {
      const w = detectionWarnings(
        detect(withSources('.tool-versions', 'pnpm-lock.yaml'), IRIS_PLAN),
        IRIS_REPO,
      )
      expect(w.map((x) => x.code)).toEqual(['version-not-from-tool-versions'])
      expect(w[0]?.message).toMatch(/^Railpack took pnpm 11\.18\.0 from pnpm-lock\.yaml/)
    })

    it('no longer judges a range against an exact pin', () => {
      const ranged = {
        ...PINNED_INFO,
        resolvedPackages: {
          ...PINNED_INFO.resolvedPackages,
          node: { ...PINNED_INFO.resolvedPackages.node, requestedVersion: '24' },
        },
      }
      expect(codes(detect(ranged, IRIS_PLAN), IRIS_REPO)).toEqual([])
    })
  })

  describe('pnpm differs from packageManager', () => {
    it('compares exact versions, ignoring the +sha512 suffix', () => {
      expect(codes(detect(PINNED_INFO, IRIS_PLAN), IRIS_REPO)).toEqual([])
      const plutus = { ...IRIS_REPO, packageManager: 'pnpm@11.25.0+sha512.abc' }
      const w = detectionWarnings(detect(PINNED_INFO, IRIS_PLAN), plutus)
      expect(w.map((x) => x.code)).toEqual(['pnpm-mismatch'])
      expect(w[0]?.message).toMatch(/pins pnpm 11\.25\.0, but Railpack resolved pnpm 11\.18\.0/)
    })

    it('warns when no pnpm was resolved', () => {
      const info = { ...PINNED_INFO, resolvedPackages: { node: PINNED_INFO.resolvedPackages.node } }
      expect(codes(detect(info, IRIS_PLAN), IRIS_REPO)).toEqual(['pnpm-mismatch'])
    })

    it('says nothing when the repo does not use pnpm', () => {
      const repo = { ...IRIS_REPO, packageManager: 'npm@11.0.0' }
      expect(codes(detect(PINNED_INFO, IRIS_PLAN), repo)).toEqual([])
    })
  })

  it('warns about a SPA registered as a server', () => {
    const repo = { ...IRIS_REPO, hasDatabase: false }
    expect(codes(detect(VITE_SPA_INFO, VITE_SPA_PLAN), repo)).toContain('spa-registered-as-server')
    expect(
      codes(detect(VITE_SPA_INFO, VITE_SPA_PLAN), { ...repo, registeredAsServer: false }),
    ).not.toContain('spa-registered-as-server')
  })

  describe("Railpack's own advice", () => {
    it('surfaces warn, suggestion and deprecation logs verbatim, and nothing else', () => {
      const info = {
        ...PINNED_INFO,
        logs: [
          { Level: 'info', Msg: 'Detected Node', DocsPath: '' },
          { Level: 'warn', Msg: IRIS_INFO.logs[1]?.Msg, DocsPath: '' },
          { Level: 'suggestion', Msg: 'Add a start script to package.json', DocsPath: '/x' },
          {
            Level: 'Deprecation',
            Msg: 'RAILPACK_OLD is deprecated; use RAILPACK_NEW',
            DocsPath: '',
          },
          { Level: 'error', Msg: 'install failed', DocsPath: '' },
        ],
      }
      // The warn-level "config file format is not yet finalized" notice is
      // dropped: every railpack.json build carries it and none can act on it.
      expect(detectionWarnings(detect(info, IRIS_PLAN), IRIS_REPO)).toEqual([
        { code: 'railpack', message: 'Add a start script to package.json' },
        { code: 'railpack', message: 'RAILPACK_OLD is deprecated; use RAILPACK_NEW' },
      ])
    })

    it("drops Railpack's standing config-format notice", () => {
      const w = codes(detect(IRIS_INFO, IRIS_PLAN), IRIS_REPO)
      expect(w).not.toContain('railpack')
    })

    it('comes last, after the checks that name a fix', () => {
      const info = {
        ...IRIS_INFO,
        logs: [...IRIS_INFO.logs, { Level: 'warn', Msg: 'Something to look at', DocsPath: '' }],
      }
      const w = codes(detect(info, IRIS_PLAN), IRIS_REPO)
      expect(w).toEqual([
        'version-not-from-tool-versions',
        'version-not-from-tool-versions',
        'railpack',
      ])
    })
  })
})
