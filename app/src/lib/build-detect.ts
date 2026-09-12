import { redactBuildLog } from './builds'
import { isRecord } from './is-record'

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
//   railpack-plan.json   plan.BuildPlan: deploy.startCommand; `secrets` is a
//                        list of the build secret NAMES the plan wants. Runtime
//                        apt packages are not a deploy field but a step named
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

/** One line of `resolvedPackages`: a tool mise installed, and who chose its version. */
export type ResolvedPackage = VersionPin & { name: string }

export type DetectionLog = {
  level: string
  message: string
  /** Railpack's own documentation anchor for the line, when it named one. */
  docsPath: string | null
}

export type Detection = {
  /** detectedProviders[0]: the provider Railpack built with. */
  provider: string | null
  /** Every entry of detectedProviders, in order: `provider` is the first. */
  providers: string[]
  /** metadata.nodeRuntime: tanstack-start, next, vite, node, static… */
  framework: string | null
  node: VersionPin | null
  pnpm: VersionPin | null
  /** Every resolved tool, node and pnpm first — the two the rest of the page names. */
  packages: ResolvedPackage[]
  startCommand: string | null
  aptPackages: string[]
  /** The NAMES of the build secrets the plan asks for. Never a value. */
  secrets: string[]
  spa: boolean
  railpackVersion: string | null
  success: boolean
  logs: DetectionLog[]
}

const text = (v: unknown): string | null => (typeof v === 'string' && v !== '' ? v : null)
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x !== '') : []

const INFO_KEYS = [
  'success',
  'railpackVersion',
  'resolvedPackages',
  'metadata',
  'detectedProviders',
  'logs',
]

function pin(resolved: unknown, name: string): VersionPin | null {
  if (!isRecord(resolved)) return null
  const pkg = resolved[name]
  if (!isRecord(pkg)) return null
  const requested = text(pkg.requestedVersion)
  const version = text(pkg.resolvedVersion) ?? requested
  if (version === null) return null
  return { version, requested, source: text(pkg.source) ?? 'unknown' }
}

/**
 * Every tool mise resolved, not only the two this file has names for. Node and
 * pnpm lead because every other line of the build page talks about them; the
 * rest follow in the order Railpack wrote them, so a Python or Bun app shows
 * its own toolchain instead of two em dashes.
 */
function packagesOf(resolved: unknown): ResolvedPackage[] {
  if (!isRecord(resolved)) return []
  const out: ResolvedPackage[] = []
  for (const name of new Set(['node', 'pnpm', ...Object.keys(resolved)])) {
    const p = pin(resolved, name)
    if (p !== null) out.push({ name, ...p })
  }
  return out
}

/**
 * The build secrets the plan wants, by name. A list today; a shape that keys
 * the names to something else still yields the names, and anything else yields
 * none — a secret NAME is all this ever shows, so no shape of it can leak.
 */
function secretsOf(plan: unknown): string[] {
  if (!isRecord(plan)) return []
  if (Array.isArray(plan.secrets)) return strings(plan.secrets)
  return isRecord(plan.secrets) ? Object.keys(plan.secrets) : []
}

const RUNTIME_APT_STEP = 'packages:apt:runtime'
const APT_NAME_PREFIX = 'install apt packages: '
const APT_CMD = /apt-get install -y ([^'"&|;]+)/

function aptPackagesOf(plan: unknown): string[] {
  if (!isRecord(plan) || !Array.isArray(plan.steps)) return []
  const found = new Set<string>()
  for (const step of plan.steps) {
    if (!isRecord(step) || step.name !== RUNTIME_APT_STEP || !Array.isArray(step.commands)) continue
    for (const command of step.commands) {
      if (!isRecord(command)) continue
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
    if (!isRecord(entry)) continue
    const message = text(entry.Msg) ?? text(entry.msg) ?? text(entry.message)
    if (message === null) continue
    out.push({
      level: text(entry.Level) ?? text(entry.level) ?? 'info',
      message: redactBuildLog(message),
      docsPath: text(entry.DocsPath) ?? text(entry.docsPath),
    })
  }
  return out
}

/**
 * The detection, or null when `info` is not a Railpack info document at all.
 * A failed `prepare` (`success: false`, reason in `logs`) still decodes.
 */
export function readDetection(info: unknown, plan?: unknown): Detection | null {
  if (!isRecord(info) || !INFO_KEYS.some((k) => k in info)) return null
  const metadata = isRecord(info.metadata) ? info.metadata : {}
  const detectedProviders = Array.isArray(info.detectedProviders) ? info.detectedProviders : []
  const deploy = isRecord(plan) && isRecord(plan.deploy) ? plan.deploy : {}

  return {
    provider: text(detectedProviders[0]),
    providers: strings(detectedProviders),
    framework: text(metadata.nodeRuntime),
    node: pin(info.resolvedPackages, 'node'),
    pnpm: pin(info.resolvedPackages, 'pnpm'),
    packages: packagesOf(info.resolvedPackages),
    startCommand: text(deploy.startCommand),
    aptPackages: aptPackagesOf(plan),
    secrets: secretsOf(plan),
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
  if (isRecord(detected) && 'info' in detected) return readDetection(detected.info, detected.plan)
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

/**
 * The same levels plus `error`, for the views that show Railpack's own lines
 * rather than judge them. An error is not a warning — it is why the build
 * stopped, and it already has the failure alert — but a reader looking at what
 * Railpack said wants it in the same list. Info is narration; it is left out.
 */
const RAILPACK_SPOKEN = [...RAILPACK_ADVICE, 'error']

/**
 * Railpack's own lines worth reading, verbatim and unfiltered — including the
 * standing config-format notice that `detectionWarnings` drops. This list is
 * the transcript; the warnings are the judgement, and the two disagreeing on
 * one line is the point.
 */
export const railpackSpoke = (detected: Detection): DetectionLog[] =>
  detected.logs.filter((l) => RAILPACK_SPOKEN.includes(l.level.toLowerCase()))

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

// ── the two halves of RepoFacts ─────────────────────────────────────────────
//
// Half of what the warnings need was read out of the clone and only the host
// build agent ever saw it; the other half is registration the agent cannot
// know. They meet here, and `statusWarnings` is the one call the scheduler
// makes.

/**
 * What the app's registration says, as against what the clone showed. None of
 * it is in the repository: whether the app was given a database, what Railpack
 * env it builds with, and whether anything about it needs a server of its own.
 */
export type AppFacts = Pick<RepoFacts, 'hasDatabase' | 'railpackEnv' | 'registeredAsServer'>

/**
 * The app row's fields these rules read. Structural rather than the repository's
 * AppRecord, so this file stays client-safe and the mapping stays testable.
 */
export type AppRegistration = {
  postgres: boolean
  storage: boolean
  litellm: boolean
  prometheus: boolean
  /** "none" | "proxy" | "native" — native means the app is the OIDC client. */
  authMode: string
  egressContainer: string | null
  railpackEnv: Record<string, string>
}

/**
 * The registration, as the warnings read it.
 *
 * `registeredAsServer` is derived rather than declared because the fleet has no
 * static-site kind — every app is a container behind traefik, so "is it a
 * server" cannot be read off one column. What can be read is what the app was
 * GIVEN: a database, object storage, a LiteLLM key, a metrics endpoint, an OIDC
 * client of its own or a VPN egress are each something only running code uses.
 * An app with none of them may legitimately be a pile of files behind Caddy,
 * and warning about that would be exactly the kind of warning people learn to
 * scroll past.
 */
export function appFacts(app: AppRegistration): AppFacts {
  return {
    hasDatabase: app.postgres,
    railpackEnv: app.railpackEnv,
    registeredAsServer:
      app.postgres ||
      app.storage ||
      app.litellm ||
      app.prometheus ||
      app.authMode === 'native' ||
      app.egressContainer !== null,
  }
}

const stringMap = (v: unknown): Record<string, string> | undefined => {
  if (!isRecord(v)) return undefined
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) if (typeof x === 'string') out[k] = x
  return out
}

/**
 * The status's `repo` key — what the agent read out of the clone — merged with
 * the engine's half.
 *
 * Tolerant for the reason readDetection is: the host agent is deployed by a
 * NixOS rebuild and this container by a git push, so the two are routinely a
 * version apart. An agent that does not publish the key yet (or publishes a
 * renamed one) must cost the checks that need it, not the build page. An absent
 * half reads as "no such file, no such dependency", which is the right answer
 * when nobody looked: every check it feeds then has nothing to say, while the
 * checks that only need Railpack's own output still run.
 */
export function readRepoFacts(raw: unknown, app: AppFacts): RepoFacts {
  const r = isRecord(raw) ? raw : {}
  const packageManager = text(r.packageManager)
  const scripts = stringMap(r.scripts)
  return {
    hasStartMjs: r.hasStartMjs === true,
    hasDatabase: app.hasDatabase,
    dependencies: strings(r.dependencies),
    productionDependencies: strings(r.productionDependencies),
    ...(packageManager === null ? {} : { packageManager }),
    allowBuilds: strings(r.allowBuilds),
    railpackEnv: app.railpackEnv,
    registeredAsServer: app.registeredAsServer,
    ...(scripts === undefined ? {} : { scripts }),
  }
}

/**
 * The warnings for one build's status, or null when there is nothing to judge.
 *
 * Null is not "clean": a Dockerfile build, or one that failed before `railpack
 * prepare`, has no detection to hold anything against, and an empty list there
 * would be a claim nobody checked. The column keeps the difference — null means
 * never computed, [] means computed and quiet — and the page says which.
 */
export function statusWarnings(
  status: { detected: unknown; repo: unknown },
  app: AppFacts,
): DetectionWarning[] | null {
  const detected = detectionFromStatus(status.detected)
  if (detected === null) return null
  return detectionWarnings(detected, readRepoFacts(status.repo, app))
}
