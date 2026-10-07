import { Link, useRouter } from '@tanstack/react-router'
import type { Detection } from '../../lib/build-detect'
import {
  type BuildSummary,
  buildDurationMs,
  detectionParts,
  isOpenBuild,
  sha7,
} from '../../lib/build-display'
import type { BuildState } from '../../lib/builds'
import { cn } from '../../lib/cn'
import { DASH, ms, since } from '../../lib/format'
import type { Tone } from '../../lib/tone'
import { buildNowFn, fetchBuilds } from '../../server/builds'
import { useLiveValue, useNow } from '../poll'
import {
  CELL_QUIET,
  SECTION_NOTE,
  SECTION_TITLE,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_LINK,
  TABLE_ROW,
  TABLE_ROW_LINK,
} from '../table'
import { Button } from '../ui/button'
import { useAction } from '../use-action'
import { Chip } from '../viz'
import { GHOST_BTN } from './shared'

// Builds on this box, as the app pages show them: the board on Deployments,
// the Build now button, and the one-line detection summary on Overview. The
// build page itself is routes/apps_.$name.builds.$id.tsx.

const STATE_TONE: Record<BuildState, Tone> = {
  queued: 'muted',
  cloning: 'info',
  detecting: 'info',
  checking: 'info',
  building: 'info',
  publishing: 'info',
  succeeded: 'ok',
  failed: 'bad',
  cancelled: 'muted',
  superseded: 'muted',
}

export function BuildStateChip({ state }: { state: BuildState }) {
  return <Chip tone={STATE_TONE[state]}>{state}</Chip>
}

/** Who asked: a push, the hourly sweep, or the person who pressed the button. */
export function requesterLabel(b: Pick<BuildSummary, 'requestedBy' | 'actor'>): string {
  if (b.requestedBy === 'webhook') return 'push'
  if (b.requestedBy === 'sweep') return 'sweep'
  return b.actor ?? 'operator'
}

/** State · commit · who asked · took · when. Two columns step away on a phone. */
const BUILD_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[7rem_5rem_minmax(0,1fr)_5.5rem_5.5rem]',
  '@max-[36rem]/table:grid-cols-[7rem_5rem_minmax(0,1fr)]',
)
const NARROW_HIDE = '@max-[36rem]/table:hidden'

/** A build's state in a table cell: the norm (succeeded) is a quiet dot and
    word; anything else keeps its tinted chip, so the exception carries the ink. */
function BuildStateCell({ state }: { state: BuildState }) {
  if (state !== 'succeeded') return <BuildStateChip state={state} />
  return (
    <span className="inline-flex items-center gap-2 text-[0.78rem] text-muted-foreground">
      <span className="size-1.5 rounded-full bg-success" aria-hidden="true" />
      succeeded
    </span>
  )
}

/** The app's last ten box builds, as a table; a row opens its build page. */
export function BuildsBoard({
  app,
  initial,
  buildOnBox,
  linked,
}: {
  app: string
  initial: BuildSummary[]
  buildOnBox: boolean
  /** The app is pinned to its GitHub repository (core/builds/link.ts). */
  linked: boolean
}) {
  const anyOpen = (bs: BuildSummary[]) => bs.some((b) => isOpenBuild(b.state))
  const builds = useLiveValue(
    initial,
    () => fetchBuilds({ data: { app, limit: 10 } }),
    3000,
    anyOpen,
  )
  const open = anyOpen(builds)
  const now = useNow(open)

  // Not linked is no refusal: Build now links the repo first.
  const refusal = !buildOnBox ? 'Box builds are off for this app.' : undefined

  return (
    <>
      <h2 className={cn(SECTION_TITLE, 'mt-0')}>
        Builds
        <span className="ml-auto">
          <BuildNowButton app={app} disabled={refusal !== undefined} reason={refusal} />
        </span>
      </h2>
      <p className={SECTION_NOTE}>
        {buildOnBox ? 'Built on this box. ' : ''}One build runs at a time. A newer push replaces a
        build still waiting in the queue rather than lining up behind it.
      </p>
      {!buildOnBox && (
        <p className="mt-0 mb-3 text-[0.82rem] text-subdued">
          Box builds are off for this app, so pushes build wherever the repo builds them today.{' '}
          <Link to="/apps/$name" params={{ name: app }} search={{ tab: 'settings' }}>
            Turn on Build on this box
          </Link>{' '}
          in its settings.
        </p>
      )}
      {buildOnBox && !linked && (
        <p className="mt-0 mb-3 text-[0.82rem] text-subdued">
          Not linked to its GitHub repository yet. Build now or the next push links it through the
          installed App.
        </p>
      )}

      {(builds.length > 0 || buildOnBox) && (
        <ul className={TABLE} aria-label="Builds">
          <li className={cn(BUILD_GRID, TABLE_HEAD)}>
            <span>State</span>
            <span>Commit</span>
            <span>Requested by</span>
            <span className={cn('text-right', NARROW_HIDE)}>Took</span>
            <span className={cn('text-right', NARROW_HIDE)}>Started</span>
          </li>
          {builds.length === 0 && <li className={TABLE_EMPTY}>No builds yet.</li>}
          {builds.map((b) => {
            // An open build's running time waits for the browser's clock.
            const took = isOpenBuild(b.state) && now === null ? null : buildDurationMs(b, now ?? 0)
            return (
              <li
                key={b.id}
                className={cn(BUILD_GRID, TABLE_ROW, TABLE_ROW_LINK)}
                title={b.error ?? b.phase}
              >
                <span>
                  <BuildStateCell state={b.state} />
                </span>
                <Link
                  to="/apps/$name/builds/$id"
                  params={{ name: app, id: b.id }}
                  className={cn(TABLE_LINK, 'font-mono text-[0.78rem] text-foreground')}
                >
                  {sha7(b.sha)}
                </Link>
                <span className="min-w-0 truncate text-muted-foreground">
                  {requesterLabel(b)}
                  {b.publish === 'candidate' && (
                    <span className="text-foreground"> · candidate</span>
                  )}
                </span>
                <span className={cn(CELL_QUIET, 'text-right', NARROW_HIDE)}>
                  {took === null ? DASH : ms(took)}
                </span>
                <span className={cn(CELL_QUIET, 'text-right', NARROW_HIDE)}>
                  {now === null ? DASH : since((now - Date.parse(b.createdAt)) / 1000)}
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </>
  )
}

/**
 * Builds the default branch's tip, then opens that build's page. The tip is
 * resolved on the server, so the button carries only the app's name.
 */
export function BuildNowButton({
  app,
  label = 'Build now',
  disabled,
  reason,
}: {
  app: string
  label?: string
  disabled?: boolean
  reason?: string
}) {
  const router = useRouter()
  const { run: act, busy, error } = useAction()

  const run = () => {
    act(() => buildNowFn({ data: { app } }), {
      invalidate: false,
      onDone: (r) =>
        router.navigate({ to: '/apps/$name/builds/$id', params: { name: app, id: r.value.id } }),
    })
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-2.5 text-[0.75rem]">
      {error !== null && <span className="max-w-[28rem] text-right text-danger">{error}</span>}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        disabled={busy || disabled === true}
        title={reason}
        onClick={run}
      >
        {busy ? 'Asking GitHub…' : label}
      </Button>
    </span>
  )
}

type OverviewBuild = {
  summary: BuildSummary
  detection: Detection | null
  warningCount: number
}

/** "Built with Railpack · Node 24.18.1 (.tool-versions) · pnpm 11.18.0 · TanStack Start". */
export function DetectionLine({ app, build }: { app: string; build: OverviewBuild }) {
  const parts = detectionParts(build.summary.resolvedStrategy, build.detection)
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-2 gap-y-1 text-[0.8rem] text-subdued">
      {/* The separator trails each part, so a wrapped line ends on a dot
          rather than starting with one. */}
      {parts.map((p) => (
        <span
          key={p.text}
          className="inline-flex items-baseline gap-2 after:text-muted-foreground after:content-['·']"
        >
          {p.code === true ? (
            <span>
              start <code>{p.text}</code>
            </span>
          ) : (
            p.text
          )}
        </span>
      ))}
      <Link
        to="/apps/$name/builds/$id"
        params={{ name: app, id: build.summary.id }}
        className="font-mono text-[0.75rem]"
      >
        {sha7(build.summary.sha)}
      </Link>
      {build.warningCount > 0 && (
        <Chip tone="warn">
          {build.warningCount} {build.warningCount === 1 ? 'warning' : 'warnings'}
        </Chip>
      )}
    </p>
  )
}
