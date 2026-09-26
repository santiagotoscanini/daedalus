import type { ReactNode } from 'react'
import { railpackSpoke } from '../../lib/build-detect'
import {
  type BuildCommit,
  type BuildView,
  buildDurationMs,
  buildQueuedMs,
  buildTimeline,
  type DeployOutcome,
  frameworkName,
  isOpenBuild,
  pushedTags,
  sha7,
  type TimelineStep,
} from '../../lib/build-display'
import { cacheHitRatio } from '../../lib/build-facts'
import { bytes, DASH, ms, pct } from '../../lib/format'
import { useSite } from '../../lib/site-context'
import { stageExposed } from '../../lib/stage'
import type { Tone } from '../../lib/tone'
import type { BuildPageApp } from '../../server/builds'
import { requesterLabel } from '../apps/builds'
import { BOARD_FOOT, VIZ_EMPTY } from '../apps/shared'
import { GuardedAwait } from '../error'
import { Alert, AlertDescription, AlertTitle } from '../ui/alert'
import { BarList, Board, Chip, Facts, Pulse } from '../viz'
import { FollowLog } from './follow-log'

// The build page's boards, one per question: what was built (Commit), what came
// out (Result), how it went (Phases, Checks), what Railpack made of the repo
// (Detection, Resolved tools, Railpack said), what the push produced (Image),
// and the log. A `…Board` component is the whole card; the others are a card's
// body, placed in their card by BuildDetail.

/** A moment as UTC minutes: the same string on the server and in the browser. */
export const at = (iso: string | null): string =>
  iso === null ? DASH : `${iso.slice(0, 16).replace('T', ' ')} UTC`

export function CommitBoard({
  build,
  commit,
  commitUrl,
  open,
  now,
}: {
  build: BuildView
  commit: Promise<BuildCommit | null> | null
  commitUrl: string
  open: boolean
  now: number | null
}) {
  const took = open && now === null ? null : buildDurationMs(build, now ?? 0)
  const waited = buildQueuedMs(build)
  return (
    <Board title="Commit" span={6}>
      <Facts
        list
        rows={[
          {
            k: 'commit',
            v: (
              <a href={commitUrl} target="_blank" rel="noreferrer" className="font-mono">
                {sha7(build.sha)} ↗
              </a>
            ),
          },
          {
            k: 'message',
            v: <CommitField commit={commit} pick={(c) => c.message.split('\n')[0] ?? ''} />,
          },
          { k: 'author', v: <CommitField commit={commit} pick={(c) => c.author ?? ''} /> },
          {
            k: 'requested by',
            v: build.requestedBy === 'operator' ? requesterLabel(build) : build.requestedBy,
          },
          {
            k: 'strategy',
            v: (
              <span className="font-mono">
                {build.strategy}
                {build.resolvedStrategy !== null && build.resolvedStrategy !== build.strategy
                  ? ` → ${build.resolvedStrategy}`
                  : ''}
              </span>
            ),
          },
          { k: 'publish', v: build.publish },
          { k: 'queued', v: at(build.createdAt) },
          { k: 'started', v: at(build.startedAt) },
          // Two numbers, not one "took": one build runs on this box at a
          // time, so a build can wait longer than it runs, and the wall
          // clock from hand-off hides exactly that.
          { k: 'waited in queue', v: waited === null ? DASH : ms(waited) },
          { k: 'ran for', v: took === null ? DASH : ms(took) },
        ]}
      />
    </Board>
  )
}

function CommitField({
  commit,
  pick,
}: {
  commit: Promise<BuildCommit | null> | null
  pick: (c: BuildCommit) => string
}) {
  const none = <span className="text-(--dim)">{DASH}</span>
  if (commit === null) return none
  return (
    <GuardedAwait resetKey="commit" promise={commit} fallback={none}>
      {(c) =>
        c === null || pick(c) === '' ? (
          none
        ) : (
          <span className="[overflow-wrap:anywhere]">{pick(c)}</span>
        )
      }
    </GuardedAwait>
  )
}

export function ResultBoard({
  name,
  app,
  build,
  open,
}: {
  name: string
  app: BuildPageApp | null
  build: BuildView
  open: boolean
}) {
  const site = useSite()
  return (
    <Board title="Result" span={6}>
      {build.digest === null ? (
        <p className={VIZ_EMPTY}>
          {open || build.state === 'queued' ? 'Nothing published yet.' : 'Nothing was published.'}
        </p>
      ) : (
        <Facts
          list
          rows={[
            {
              k: 'digest',
              v: (
                <code title={build.digest}>{build.digest.replace('sha256:', '').slice(0, 12)}</code>
              ),
            },
            {
              k: 'image',
              v: <code title={build.imageRef ?? undefined}>{`${site.registryHost}/${name}`}</code>,
            },
            tagsRow(build),
            // Not "size": it is the manifest's compressed layers plus its
            // config, which is what a pull moves — an unpacked image on
            // disk is a different, larger number.
            { k: 'pull size', v: bytes(build.sizeBytes) },
          ]}
        />
      )}
      <Facts list rows={[{ k: 'deploy', v: <Outcome outcome={build.deploy} /> }]} />
      {app !== null && stageExposed(app.stage) && build.deploy.kind === 'deployed' && (
        <p className="m-0 text-[0.82rem]">
          <a href={`https://${app.effectiveHostname}`} target="_blank" rel="noreferrer">
            ↗ {app.effectiveHostname}
          </a>
        </p>
      )}
    </Board>
  )
}

/**
 * The `tags` row of the Result board. The agent reads back what the push left
 * on the registry; without it the tags are derived from the publish mode and
 * the sha, and the row says so rather than passing a guess off as a reading.
 */
function tagsRow(build: BuildView): { k: string; v: ReactNode } {
  const t = pushedTags(build.publish, build.sha, build.facts?.image?.tags)
  return {
    k: t.actual ? 'tags' : 'tags (expected)',
    v: (
      <span className="inline-flex flex-wrap justify-end gap-1">
        {t.tags.map((tag) => (
          <code key={tag} className="text-[0.76rem]" title={tag}>
            {tag.length > 20 ? `${tag.slice(0, tag.indexOf('-') + 8)}…` : tag}
          </code>
        ))}
      </span>
    ),
  }
}

function Outcome({ outcome }: { outcome: DeployOutcome }) {
  switch (outcome.kind) {
    case 'none':
      return <span className="text-(--dim)">{DASH}</span>
    case 'candidate':
      return <span>candidate, not deployed</span>
    case 'pinned':
      return (
        <span>
          {outcome.why === 'frozen'
            ? 'built, not deployed: auto-deploy is off'
            : 'built, not deployed: the app is held on an image override'}
        </span>
      )
    case 'waiting':
      return <span className="text-(--text-muted)">waiting for the deploy</span>
    case 'deployed':
      return (
        <span className={outcome.result === 'ok' ? 'text-success' : 'text-danger'}>
          deployed, {outcome.result}
          {outcome.httpCode !== null ? ` (HTTP ${outcome.httpCode})` : ''} at {at(outcome.at)}
        </span>
      )
  }
}

export function PhasesBoard({ build, open }: { build: BuildView; open: boolean }) {
  return (
    <Board title="Phases" span={6}>
      <ol className="m-0 list-none p-0">
        {buildTimeline(build.state, build.timings).map((s) => (
          <Step key={s.phase} step={s} />
        ))}
      </ol>
      {open && build.phase !== '' && <p className={BOARD_FOOT}>Now: {build.phase}</p>}
    </Board>
  )
}

const STEP_TONE: Record<TimelineStep['status'], Tone> = {
  done: 'ok',
  running: 'info',
  failed: 'bad',
  pending: 'muted',
  skipped: 'muted',
}

// What the right-hand column says when there is no duration to put there. A
// skipped phase says so in words: "—" beside a green build read as "passed,
// too fast to time", which is how checks that never ran came to look like
// checks that passed.
const STEP_NOTE: Partial<Record<TimelineStep['status'], string>> = {
  failed: 'failed',
  skipped: 'did not run',
}

function Step({ step }: { step: TimelineStep }) {
  return (
    <li className="flex items-center gap-[0.6rem] border-t border-(--border-soft) py-[0.4rem] text-[0.84rem] first:border-t-0 first:pt-0">
      <Pulse on={step.status === 'running'} tone={STEP_TONE[step.status]} />
      <span
        className={
          step.status === 'pending' || step.status === 'skipped'
            ? 'text-(--dim)'
            : step.status === 'failed'
              ? 'text-danger'
              : undefined
        }
      >
        {step.phase}
      </span>
      <span className="ml-auto font-mono text-[0.78rem] text-(--dim)">
        {STEP_NOTE[step.status] ?? (step.ms === null ? DASH : ms(step.ms))}
      </span>
    </li>
  )
}

export function Checks({ build }: { build: BuildView }) {
  const checks = build.checks
  if (checks === null || (checks.ran.length === 0 && checks.failed === null)) {
    return (
      <p className={VIZ_EMPTY}>
        {isOpenBuild(build.state) ? 'No checks have run yet.' : 'No checks ran.'}
      </p>
    )
  }
  const names =
    checks.failed !== null && !checks.ran.includes(checks.failed)
      ? [...checks.ran, checks.failed]
      : checks.ran
  return (
    <>
      <ol className="m-0 list-none p-0">
        {names.map((c) => {
          const failed = c === checks.failed
          return (
            <li
              key={c}
              className="flex items-center gap-[0.6rem] border-t border-(--border-soft) py-[0.4rem] text-[0.84rem] first:border-t-0 first:pt-0"
            >
              <span aria-hidden="true" className={failed ? 'text-danger' : 'text-success'}>
                {failed ? '✕' : '✓'}
              </span>
              <code className={failed ? 'text-danger' : undefined}>{c}</code>
              {failed && <span className="ml-auto text-[0.78rem] text-danger">failed</span>}
            </li>
          )
        })}
      </ol>
      <p className={BOARD_FOOT}>
        {checks.failed === null
          ? `${String(names.length)} ran, none failed.`
          : `${checks.failed} failed, so nothing was built past it.`}
      </p>
    </>
  )
}

export function Detection({ build }: { build: BuildView }) {
  const d = build.detection
  if (d === null) {
    return (
      <p className={VIZ_EMPTY}>
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
        <code>{p.version}</code> <span className="text-(--dim)">from {p.source}</span>
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
        <p className={BOARD_FOOT}>
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
        <p className={BOARD_FOOT}>Checked; no warnings.</p>
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
    return <p className={VIZ_EMPTY}>Railpack resolved no tools for this build.</p>
  }
  return (
    <ul className="m-0 list-none p-0">
      {packages.map((p) => (
        <li
          key={p.name}
          className="grid grid-cols-[7rem_1fr] items-baseline gap-x-3 gap-y-[0.1rem] border-t border-(--border-soft) py-[0.45rem] text-[0.84rem] first:border-t-0 first:pt-0"
        >
          <code className="truncate" title={p.name}>
            {p.name}
          </code>
          <span className="min-w-0">
            <code>{p.version}</code>
            {p.requested !== null && p.requested !== p.version && (
              <span className="text-(--dim)"> asked for {p.requested}</span>
            )}
          </span>
          <span />
          <span className="min-w-0 text-[0.78rem] text-(--dim) [overflow-wrap:anywhere]">
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
      <p className={VIZ_EMPTY}>
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
    if (run.secretsHash !== null) {
      // The fingerprint, never a value: it is here so two builds can be told
      // apart by whether their secrets changed.
      rows.push({
        k: 'secrets hash',
        v: <code title={run.secretsHash}>{run.secretsHash.slice(0, 12)}</code>,
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
        <p className={BOARD_FOOT}>
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
      <p className={VIZ_EMPTY}>
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
          className="flex flex-wrap items-baseline gap-x-[0.6rem] gap-y-[0.15rem] border-t border-(--border-soft) py-[0.45rem] text-[0.84rem] first:border-t-0 first:pt-0"
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

const LOG_TONE: Record<string, Tone> = {
  error: 'bad',
  warn: 'warn',
  deprecation: 'warn',
  suggestion: 'info',
}

/**
 * Railpack names its documentation by path (`/config/…`), against its own site.
 * An absolute URL is passed through, so a version that starts writing one does
 * not turn into `https://railpack.com/https://…`.
 */
const docsUrl = (path: string): string =>
  /^https?:\/\//i.test(path)
    ? path
    : `https://railpack.com${path.startsWith('/') ? '' : '/'}${path}`

export function LogBoard({ build, open }: { build: BuildView; open: boolean }) {
  return (
    <Board title="Log" span={12} aside={open ? <Chip tone="info">following</Chip> : undefined}>
      {build.log.available ? (
        <FollowLog text={build.log.text} />
      ) : (
        <p className={VIZ_EMPTY}>
          {build.state === 'queued'
            ? 'Queued. The log starts when the host picks the build up.'
            : 'The host has no log for this build.'}
        </p>
      )}
      <p className={BOARD_FOOT}>
        {build.log.truncated ? `The last 64 KB of ${bytes(build.log.sizeBytes)}. ` : ''}
        Credentials are redacted twice: by the host as it writes the log, and here as it is read.
      </p>
    </Board>
  )
}
