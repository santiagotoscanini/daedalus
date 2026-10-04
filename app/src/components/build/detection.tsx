// The build page's boards about how it was built: what was detected, the
// tools, the image it published, and what Railpack said.

import type { ReactNode } from 'react'
import { railpackSpoke } from '../../lib/build-detect'
import { type BuildView, frameworkName, isOpenBuild } from '../../lib/build-display'
import { cacheHitRatio } from '../../lib/build-facts'
import { bytes, DASH, pct } from '../../lib/format'
import { EMPTY, FOOT } from '../tokens'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { BarList, Chip, Facts } from '../viz'
import { docsUrl, LOG_TONE } from './boards'

export function Detection({ build }: { build: BuildView }) {
  const d = build.detection
  if (d === null) {
    return (
      <p className={EMPTY}>
        {build.resolvedStrategy === 'dockerfile'
          ? 'Built from the repo’s Dockerfile, so Railpack did not look at it.'
          : isOpenBuild(build.state) || build.state === 'queued'
            ? 'Railpack has not looked at the repo yet.'
            : 'No detection was recorded for this build.'}
      </p>
    )
  }
  const pin = (p: typeof d.node) =>
    p === null ? (
      DASH
    ) : (
      <span>
        <code>{p.version}</code> <span className="text-muted-foreground">from {p.source}</span>
      </span>
    )
  const warnings = build.warnings
  return (
    <>
      <Facts
        rows={[
          // Every provider, not only the one that won: a repo Railpack read as
          // both a Node app and a static site is worth seeing as both.
          { k: 'providers', v: d.providers.length === 0 ? DASH : d.providers.join(', ') },
          { k: 'framework', v: d.framework === null ? DASH : frameworkName(d.framework) },
          { k: 'Node', v: pin(d.node) },
          { k: 'pnpm', v: pin(d.pnpm) },
          { k: 'start', v: d.startCommand === null ? DASH : <code>{d.startCommand}</code> },
          {
            k: 'apt packages',
            v: d.aptPackages.length === 0 ? 'none' : <code>{d.aptPackages.join(' ')}</code>,
          },
          {
            // Names only. A value never leaves the host, and nothing on this
            // page has ever held one.
            k: 'build secrets',
            v: d.secrets.length === 0 ? 'none' : <code>{d.secrets.join(' ')}</code>,
          },
          { k: 'Railpack', v: d.railpackVersion ?? DASH },
          { k: 'served as', v: d.spa ? 'static single-page app' : 'server' },
        ]}
      />
      {/* Only when it failed: a successful prepare is what every other row on
          this card already says, and a green "succeeded" row would be noise. */}
      {!d.success && (
        <Alert variant="destructive">
          <AlertTitle>Railpack’s detection did not succeed</AlertTitle>
          <AlertDescription>
            <p className="m-0">
              `railpack prepare` reported failure. Its own lines are under “Railpack said”.
            </p>
          </AlertDescription>
        </Alert>
      )}
      {warnings === null ? (
        // Never "no warnings": this build was judged by nobody. Every row from
        // before the engine learned to compute them reads this way, and so
        // does one whose detection is not Railpack's at all.
        <p className={FOOT}>
          No warnings were computed for this build — it predates the checks, so this is not a clean
          bill of health.
        </p>
      ) : warnings.length > 0 ? (
        <Alert variant="warning">
          <AlertTitle>
            {warnings.length === 1 ? 'One warning' : `${String(warnings.length)} warnings`}
          </AlertTitle>
          <AlertDescription>
            <ul className="m-0 flex list-disc flex-col gap-1 pl-4">
              {warnings.map((w) => (
                <li key={`${w.code}:${w.message}`}>{w.message}</li>
              ))}
            </ul>
          </AlertDescription>
        </Alert>
      ) : (
        <p className={FOOT}>Checked; no warnings.</p>
      )}
    </>
  )
}

/**
 * Every tool mise resolved and who chose its version. The source column is the
 * one that earns the board: "railpack default" and "package.json > engines"
 * look identical in a build log and mean entirely different things the next
 * time the image is rebuilt.
 */
export function Tools({ build }: { build: BuildView }) {
  const packages = build.detection?.packages ?? []
  if (packages.length === 0) {
    return <p className={EMPTY}>Railpack resolved no tools for this build.</p>
  }
  return (
    <ul className="m-0 list-none p-0">
      {packages.map((p) => (
        <li
          key={p.name}
          className="grid grid-cols-[7rem_1fr] items-baseline gap-x-3 gap-y-[0.1rem] border-t border-subtle py-[0.45rem] text-[0.84rem] first:border-t-0 first:pt-0"
        >
          <code className="truncate" title={p.name}>
            {p.name}
          </code>
          <span className="min-w-0">
            <code>{p.version}</code>
            {p.requested !== null && p.requested !== p.version && (
              <span className="text-muted-foreground"> asked for {p.requested}</span>
            )}
          </span>
          <span />
          <span className="min-w-0 text-[0.78rem] text-muted-foreground [overflow-wrap:anywhere]">
            from {p.source}
          </span>
        </li>
      ))}
    </ul>
  )
}

/**
 * What the push produced, as the agent read it back off the manifest: how many
 * layers, how big each one is compressed, and what the cache did. A layer list
 * is the fastest way to see a build that started shipping node_modules.
 */
export function ImageBoard({ build }: { build: BuildView }) {
  const image = build.facts?.image ?? null
  const run = build.facts?.run ?? null
  if (image === null && run === null) {
    return (
      <p className={EMPTY}>
        {build.digest === null
          ? 'No image was published.'
          : 'The host agent recorded no image facts for this build.'}
      </p>
    )
  }
  const ratio = cacheHitRatio(run)
  const rows: { k: string; v: ReactNode }[] = []
  if (image !== null) {
    if (image.layers !== null) rows.push({ k: 'layers', v: String(image.layers) })
    if (image.configSize !== null) rows.push({ k: 'config', v: bytes(image.configSize) })
    if (image.mediaType !== null) {
      rows.push({ k: 'media type', v: <code className="text-[0.72rem]">{image.mediaType}</code> })
    }
  }
  if (run !== null) {
    if (run.runner !== null) rows.push({ k: 'runner', v: <code>{run.runner}</code> })
    if (run.stepsTotal !== null) {
      rows.push({
        k: 'steps cached',
        v: `${String(run.stepsCached ?? 0)} of ${String(run.stepsTotal)}${
          ratio === null ? '' : ` (${pct(ratio * 100)})`
        }`,
      })
    }
    if (run.cacheImported !== null || run.cacheExported !== null) {
      rows.push({
        k: 'cache',
        v: [
          run.cacheImported === null ? null : run.cacheImported ? 'imported' : 'cold',
          run.cacheExported === null ? null : run.cacheExported ? 'exported' : 'not exported',
        ]
          .filter((s): s is string => s !== null)
          .join(', '),
      })
    }
  }
  const layers = image?.layerSizes ?? []
  return (
    <>
      {rows.length > 0 && <Facts list rows={rows} />}
      {layers.length > 0 && (
        <BarList
          items={layers.map((size, i) => ({
            label: `layer ${String(i + 1)}`,
            value: size,
            display: bytes(size),
          }))}
          tone="info"
        />
      )}
      {layers.length > 0 && (
        <p className={FOOT}>
          Compressed sizes from the manifest — these plus the config are the pull size above.
        </p>
      )}
    </>
  )
}

/**
 * Railpack's own lines, verbatim. Deliberately overlapping the warnings above:
 * this is the transcript, warnings and errors and the standing config-format
 * notice included, while the warnings list is the judgement made of it.
 */
export function RailpackSaid({ build }: { build: BuildView }) {
  const d = build.detection
  const spoken = d === null ? [] : railpackSpoke(d)
  if (spoken.length === 0) {
    return (
      <p className={EMPTY}>
        {d === null
          ? 'Railpack did not look at this build.'
          : 'Railpack logged nothing above info level.'}
      </p>
    )
  }
  return (
    <ul className="m-0 list-none p-0">
      {spoken.map((l) => (
        <li
          key={`${l.level}:${l.message}`}
          className="flex flex-wrap items-baseline gap-x-[0.6rem] gap-y-[0.15rem] border-t border-subtle py-[0.45rem] text-[0.84rem] first:border-t-0 first:pt-0"
        >
          <Chip tone={LOG_TONE[l.level.toLowerCase()] ?? 'muted'}>{l.level.toLowerCase()}</Chip>
          <span className="min-w-0 flex-1 [overflow-wrap:anywhere]">{l.message}</span>
          {l.docsPath !== null && (
            <a
              href={docsUrl(l.docsPath)}
              target="_blank"
              rel="noreferrer"
              className="text-[0.78rem]"
            >
              docs ↗
            </a>
          )}
        </li>
      ))}
    </ul>
  )
}
