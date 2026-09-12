import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { Detection } from '../../lib/build-detect'
import {
  type BuildSummary,
  buildDurationMs,
  detectionParts,
  isOpenBuild,
  sha7,
} from '../../lib/build-display'
import type { BuildState } from '../../lib/builds'
import { DASH, ms, since } from '../../lib/format'
import type { Tone } from '../../lib/tone'
import { buildNowFn, fetchBuilds } from '../../server/builds'
import { Button } from '../ui/button'
import { Board, Chip } from '../viz'
import { BOARD_FOOT, GHOST_BTN, VIZ_EMPTY } from './shared'

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

/**
 * `Date.now()` after mount only, ticking while something runs. A running
 * build's elapsed time rendered on the server would never match the client's.
 */
export function useNow(active: boolean): number | null {
  const [now, setNow] = useState<number | null>(null)
  useEffect(() => {
    setNow(Date.now())
    if (!active) return
    const t = setInterval(() => {
      setNow(Date.now())
    }, 1000)
    return () => {
      clearInterval(t)
    }
  }, [active])
  return now
}

const ROW =
  'grid grid-cols-[6.2rem_4.6rem_minmax(0,1fr)_5.2rem_6.5rem] items-baseline gap-x-[0.8rem] border-t border-(--border-soft) px-[0.2rem] py-[0.45rem] text-[0.8rem] no-underline first:border-t-0 hover:bg-(--panel-2) hover:no-underline max-[40rem]:grid-cols-[6.2rem_4.6rem_minmax(0,1fr)]'

export function BuildsBoard({
  app,
  initial,
  buildOnBox,
  linked,
}: {
  app: string
  initial: BuildSummary[]
  buildOnBox: boolean
  /** The sweep has matched the app to its GitHub repository. */
  linked: boolean
}) {
  const [builds, setBuilds] = useState(initial)
  useEffect(() => {
    setBuilds(initial)
  }, [initial])

  const open = builds.some((b) => isOpenBuild(b.state))
  const now = useNow(open)

  useEffect(() => {
    if (!open) return
    const t = setInterval(() => {
      void fetchBuilds({ data: { app, limit: 10 } })
        .then((r) => {
          if (r !== null) setBuilds(r)
        })
        .catch(() => {})
    }, 3000)
    return () => {
      clearInterval(t)
    }
  }, [open, app])

  const refusal = !buildOnBox
    ? 'Box builds are off for this app.'
    : !linked
      ? 'Waiting for the sweep to link the repo.'
      : undefined

  return (
    <Board
      title="Builds"
      span={12}
      aside={<BuildNowButton app={app} disabled={refusal !== undefined} reason={refusal} />}
    >
      {!buildOnBox && (
        <p className="m-0 text-[0.82rem] text-(--text-muted)">
          Box builds are off for this app, so pushes build wherever the repo builds them today.{' '}
          <Link to="/apps/$name" params={{ name: app }} search={{ tab: 'settings' }}>
            Turn on Build on this box
          </Link>{' '}
          in its settings.
        </p>
      )}
      {buildOnBox && !linked && (
        <p className="m-0 text-[0.82rem] text-(--text-muted)">
          Waiting for the sweep to link this app to its GitHub repository. Pushes and Build now
          start working once it has.
        </p>
      )}

      {builds.length === 0 ? (
        buildOnBox && <p className={VIZ_EMPTY}>No builds yet.</p>
      ) : (
        <ol className="m-0 list-none p-0">
          {builds.map((b) => {
            const took = buildDurationMs(b, now ?? Date.now())
            return (
              <li key={b.id}>
                <Link
                  to="/apps/$name/builds/$id"
                  params={{ name: app, id: b.id }}
                  className={ROW}
                  title={b.error ?? b.phase}
                >
                  <span>
                    <BuildStateChip state={b.state} />
                  </span>
                  <code className="text-foreground">{sha7(b.sha)}</code>
                  <span className="min-w-0 truncate text-(--text-muted)">
                    {requesterLabel(b)}
                    {b.publish === 'candidate' && (
                      <span className="text-(--dim)"> · candidate</span>
                    )}
                  </span>
                  <span className="text-right font-mono text-[0.76rem] text-(--dim) max-[40rem]:hidden">
                    {took === null || (isOpenBuild(b.state) && now === null) ? DASH : ms(took)}
                  </span>
                  <span className="text-right text-[0.76rem] text-(--dim) max-[40rem]:hidden">
                    {now === null ? DASH : since((now - Date.parse(b.createdAt)) / 1000)}
                  </span>
                </Link>
              </li>
            )
          })}
        </ol>
      )}

      <p className={BOARD_FOOT}>
        One build runs at a time. A newer push replaces a build still waiting in the queue rather
        than lining up behind it.
      </p>
    </Board>
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
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const run = () => {
    setBusy(true)
    setError(null)
    void buildNowFn({ data: { app } })
      .then(async (r) => {
        if (r.ok) {
          await router.navigate({ to: '/apps/$name/builds/$id', params: { name: app, id: r.id } })
        } else {
          setError(r.reason)
        }
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-[0.6rem] text-[0.76rem]">
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

export type OverviewBuild = {
  summary: BuildSummary
  detection: Detection | null
  warningCount: number
}

/** "Built with Railpack · Node 24.18.1 (.tool-versions) · pnpm 11.18.0 · TanStack Start". */
export function DetectionLine({ app, build }: { app: string; build: OverviewBuild }) {
  const parts = detectionParts(build.summary.resolvedStrategy, build.detection)
  return (
    <p className="m-0 flex flex-wrap items-baseline gap-x-[0.45rem] gap-y-1 text-[0.8rem] text-(--text-muted)">
      {parts.map((p, i) => (
        <span key={p.text} className="inline-flex items-baseline gap-[0.45rem]">
          {i > 0 && (
            <span aria-hidden="true" className="text-(--dim)">
              ·
            </span>
          )}
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
        className="font-mono text-[0.76rem]"
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
