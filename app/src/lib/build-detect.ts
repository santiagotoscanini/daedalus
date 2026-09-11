import { redactBuildLog } from './builds'

// What Railpack decided an app is, and what about that decision is likely
// wrong. Pure and client-safe; the build page and the overview render it.
//
// Inputs are the two files `railpack prepare` writes (Railpack v0.39.0):
//
//   railpack-info.json   core.BuildResult with `plan` dropped (cli/prepare.go
//                        writeInfoFile): railpackVersion, resolvedPackages
//                        { <name>: { name, requestedVersion, resolvedVersion,
//                        source } }, metadata (map[string]string — booleans are
//                        the string "true", and absent when false),
//                        detectedProviders[], logs[], success.
//                        logger.Msg has no json tags, so a log entry is
//                        { Level, Msg, DocsPath }.
//   railpack-plan.json   plan.BuildPlan: deploy.startCommand; runtime apt
//                        packages are not a deploy field but a step named
//                        `packages:apt:runtime` whose command is
//                        `sh -c 'apt-get update && apt-get install -y …'`,
//                        customName `install apt packages: …`.
//
// Decoded by hand and tolerantly: Railpack is 0.x with breaking minors, and a
// renamed field should blank one line of the build page, not the whole card.

export type VersionPin = {
  /** What was installed: resolvedVersion, else requestedVersion. */
  version: string
  /** What the source asked for — "24", ">=18", "11.5.x", "24.18.1". */
  requested: string | null
  /** Railpack's words: ".tool-versions", "custom config", "railpack default"… */
  source: string
}

export type DetectionLog = { level: string; message: string }

export type Detection = {
  /** detectedProviders[0]: the provider Railpack built with. */
  provider: string | null
  /** metadata.nodeRuntime: tanstack-start, next, vite, node, static… */
  framework: string | null
  node: VersionPin | null
  pnpm: VersionPin | null
  startCommand: string | null
  aptPackages: string[]
  spa: boolean
  railpackVersion: string | null
  success: boolean
  logs: DetectionLog[]
}

type Rec = Record<string, unknown>

const isRec = (v: unknown): v is Rec => v !== null && typeof v === 'object' && !Array.isArray(v)
const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)

const INFO_KEYS = [
  'success',
  'railpackVersion',
  'resolvedPackages',
  'metadata',
  'detectedProviders',
  'logs',
]

function pin(resolved: unknown, name: string): VersionPin | null {
  if (!isRec(resolved)) return null
  const pkg = resolved[name]
  if (!isRec(pkg)) return null
  const requested = text(pkg.requestedVersion)
  const version = text(pkg.resolvedVersion) ?? requested
  if (version === null) return null
  return { version, requested, source: text(pkg.source) ?? 'unknown' }
}

const RUNTIME_APT_STEP = 'packages:apt:runtime'
const APT_NAME_PREFIX = 'install apt packages: '
const APT_CMD = /apt-get install -y ([^'"&|;]+)/

function aptPackagesOf(plan: unknown): string[] {
  if (!isRec(plan) || !Array.isArray(plan.steps)) return []
  const found = new Set<string>()
  for (const step of plan.steps) {
    if (!isRec(step) || step.name !== RUNTIME_APT_STEP || !Array.isArray(step.commands)) continue
    for (const command of step.commands) {
      if (!isRec(command)) continue
      const custom = text(command.customName)
      const fromCmd = APT_CMD.exec(text(command.cmd) ?? '')?.[1]
      const list = custom?.startsWith(APT_NAME_PREFIX)
        ? custom.slice(APT_NAME_PREFIX.length)
        : (fromCmd ?? '')
      for (const p of list.split(/\s+/)) if (p !== '') found.add(p)
    }
  }
  return [...found]
}

function logsOf(logs: unknown): DetectionLog[] {
  if (!Array.isArray(logs)) return []
  const out: DetectionLog[] = []
  for (const entry of logs) {
    if (!isRec(entry)) continue
    const message = text(entry.Msg) ?? text(entry.msg) ?? text(entry.message)
    if (message === null) continue
    out.push({
      level: text(entry.Level) ?? text(entry.level) ?? 'info',
      message: redactBuildLog(message),
    })
  }
  return out
}

/**
 * The detection, or null when `info` is not a Railpack info document at all.
 * A failed `prepare` (`success: false`, reason in `logs`) still decodes.
 */
export function readDetection(info: unknown, plan?: unknown): Detection | null {
  if (!isRec(info) || !INFO_KEYS.some((k) => k in info)) return null
  const metadata = isRec(info.metadata) ? info.metadata : {}
  const detectedProviders = Array.isArray(info.detectedProviders) ? info.detectedProviders : []
  const deploy = isRec(plan) && isRec(plan.deploy) ? plan.deploy : {}

  return {
    provider: text(detectedProviders[0]),
    framework: text(metadata.nodeRuntime),
    node: pin(info.resolvedPackages, 'node'),
    pnpm: pin(info.resolvedPackages, 'pnpm'),
    startCommand: text(deploy.startCommand),
    aptPackages: aptPackagesOf(plan),
    spa: metadata.nodeIsSPA === 'true' || metadata.nodeIsSPA === true,
    railpackVersion: text(info.railpackVersion),
    success: info.success === true,
    logs: logsOf(info.logs),
  }
}

/**
 * The status's `detected` field: `{ info, plan }` as the host copies it, or a
 * bare info document.
 */
export function detectionFromStatus(detected: unknown): Detection | null {
  if (isRec(detected) && 'info' in detected) return readDetection(detected.info, detected.plan)
  return readDetection(detected)
}

// ── warnings ────────────────────────────────────────────────────────────────

export type RepoFacts = {
  hasStartMjs: boolean
  hasDatabase: boolean
  /** dependencies + devDependencies names from package.json. */
  dependencies: string[]
  /** `dependencies` names only — what the production image keeps. */
  productionDependencies: string[]
  /** package.json `packageManager`, e.g. "pnpm@11.18.0+sha512.…". */
  packageManager?: string
  /** pnpm-workspace.yaml `allowBuilds` entries set to true. */
  allowBuilds: string[]
  /** The app's Railpack env (apps.railpackEnv). */
  railpackEnv: Record<string, string>
  registeredAsServer: boolean
  /**
   * package.json `scripts`. Optional: without it a `pnpm run start` start
   * command cannot be shown to reach start.mjs, and is warned about.
   */
  scripts?: Record<string, string>
}

export type DetectionWarningCode =
  | 'start-bypasses-migrations'
  | 'puppeteer-core-without-chromium'
  | 'puppeteer-build-not-allowed'
  | 'playwright-without-install'
  | 'version-not-from-tool-versions'
  | 'pnpm-mismatch'
  | 'spa-registered-as-server'
  | 'railpack'

export type DetectionWarning = { code: DetectionWarningCode; message: string }

const RUN_SCRIPT = /^(?:pnpm|npm|yarn|bun)\s+(?:run\s+)?([\w:.-]+)\s*$/

function reachesStartMjs(command: string | null, scripts: Record<string, string> | undefined) {
  if (command === null) return false
  if (command.includes('start.mjs')) return true
  const script = RUN_SCRIPT.exec(command)?.[1]
  return script !== undefined && (scripts?.[script] ?? '').includes('start.mjs')
}

const stripBuild = (v: string): string => v.trim().replace(/^v/, '').replace(/\+.*$/, '')

/** mise names the file a version came from, and Railpack passes it on as `source`. */
const fromToolVersions = (source: string): boolean => /tool-versions/i.test(source)

const isChromium = (pkg: string): boolean => pkg === 'chromium' || pkg.startsWith('chromium-')

const PLAYWRIGHT_INSTALL = 'RAILPACK_NODE_PLAYWRIGHT_INSTALL'

/** Railpack log levels that are advice to the app, not narration. */
const RAILPACK_ADVICE = ['warn', 'suggestion', 'deprecation']

export function detectionWarnings(detected: Detection, repo: RepoFacts): DetectionWarning[] {
  const warnings: DetectionWarning[] = []

  if (
    repo.hasStartMjs &&
    repo.hasDatabase &&
    !reachesStartMjs(detected.startCommand, repo.scripts)
  ) {
    warnings.push({
      code: 'start-bypasses-migrations',
      message:
        detected.startCommand === null
          ? 'Railpack found no start command, and this app has start.mjs and a database: ' +
            'migrations would not run. Set deploy.startCommand to "node start.mjs" in railpack.json.'
          : `The start command \`${detected.startCommand}\` does not go through start.mjs, ` +
            'and this app has a database: migrations would not run. Set deploy.startCommand ' +
            'to "node start.mjs" in railpack.json.',
    })
  }

  if (repo.dependencies.includes('puppeteer-core') && !detected.aptPackages.some(isChromium)) {
    warnings.push({
      code: 'puppeteer-core-without-chromium',
      message:
        'puppeteer-core is a dependency, but Railpack does nothing for it and the image has no ' +
        'chromium apt package. Add chromium to deploy.aptPackages in railpack.json.',
    })
  }

  const usesPnpm =
    detected.pnpm !== null || (repo.packageManager?.trim().startsWith('pnpm@') ?? false)
  if (
    usesPnpm &&
    repo.dependencies.includes('puppeteer') &&
    !repo.allowBuilds.includes('puppeteer')
  ) {
    warnings.push({
      code: 'puppeteer-build-not-allowed',
      message:
        'puppeteer is a dependency, but pnpm-workspace.yaml does not allow its build, so pnpm 11 ' +
        'fails the postinstall that downloads its browser. Add `puppeteer: true` under ' +
        'allowBuilds in pnpm-workspace.yaml.',
    })
  }

  if (
    repo.productionDependencies.includes('playwright') &&
    (repo.railpackEnv[PLAYWRIGHT_INSTALL] ?? '').trim() === ''
  ) {
    warnings.push({
      code: 'playwright-without-install',
      message:
        `playwright is a production dependency, but ${PLAYWRIGHT_INSTALL} is not set in the ` +
        "app's Railpack env, so no browser is installed in the image.",
    })
  }

  for (const [name, p] of [
    ['Node', detected.node],
    ['pnpm', detected.pnpm],
  ] as const) {
    if (p === null || fromToolVersions(p.source)) continue
    warnings.push({
      code: 'version-not-from-tool-versions',
      message:
        `Railpack took ${name} ${p.version} from ${p.source}, not from the app's .tool-versions. ` +
        `Pin ${name} in .tool-versions.`,
    })
  }

  const pm = repo.packageManager?.trim()
  if (pm?.startsWith('pnpm@')) {
    const want = stripBuild(pm.slice('pnpm@'.length))
    const got = detected.pnpm === null ? null : stripBuild(detected.pnpm.version)
    if (got !== want) {
      warnings.push({
        code: 'pnpm-mismatch',
        message:
          got === null
            ? `package.json pins pnpm ${want}, but Railpack resolved no pnpm.`
            : `package.json pins pnpm ${want}, but Railpack resolved pnpm ${got} ` +
              `(from ${detected.pnpm?.source ?? 'unknown'}).`,
      })
    }
  }

  if (detected.spa && repo.registeredAsServer) {
    warnings.push({
      code: 'spa-registered-as-server',
      message:
        'Railpack detected a static single-page app (served by Caddy), but this app is ' +
        'registered as a server: its server routes would not exist. Set deploy.startCommand ' +
        'in railpack.json to force server mode.',
    })
  }

  for (const log of detected.logs) {
    // Railpack warns on every build that reads a railpack.json that the config
    // format "is not yet finalized". It is true of every app and actionable for
    // none, so repeating it would train people to ignore the warnings list.
    if (/config file format is not yet finalized/i.test(log.message)) continue
    if (RAILPACK_ADVICE.includes(log.level.toLowerCase())) {
      warnings.push({ code: 'railpack', message: log.message })
    }
  }

  return warnings
}
