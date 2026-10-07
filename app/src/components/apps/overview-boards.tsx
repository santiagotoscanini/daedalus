// The overview's boards: the picture of the last deploy, what is deployed, and
// the workspace clone. Split from overview.tsx so each stays one component per
// board and the page file is only the layout.

import { useRouter } from '@tanstack/react-router'
import { RotateCwIcon } from 'lucide-react'
import { DASH, since } from '../../lib/format'
import { type AppTabData, triggerDeploy } from '../../server/registry'
import { Ago } from '../ago'
import { useNow } from '../poll'
import { useRootAction } from '../root-action'
import { EMPTY } from '../tokens'
import { Button } from '../ui/button'
import { Board, Facts } from '../viz'
import { CloneButton } from '../workspace'
import { DetectionLine } from './builds'
import { type AppRecord, GHOST_BTN, type LoaderData } from './shared'

type Frame = NonNullable<LoaderData>

/** The quiet value face: what every healthy row reads as. */
const QUIET = 'text-muted-foreground'

/**
 * An image reference short enough to sit in a value column.
 *
 * The registry host is the same for every app here and the tag is `latest` for
 * almost all of them, so the middle is the only part that identifies anything.
 * The full string stays in the title.
 */
function shortImage(ref: string): string {
  const slash = ref.lastIndexOf('/')
  return slash === -1 ? ref : ref.slice(slash + 1)
}

/**
 * What the app looked like moments after its last deploy — taken by
 * shot-deploy-<name> on the host, anonymous-visitor view. Not live: it ages
 * with the deploy, which is the point. The picture fills the board, so the
 * board is as tall as its neighbours and crops from the top.
 */
export function PreviewBoard({
  name,
  shot,
  lastDeploy,
}: {
  name: string
  shot: NonNullable<Frame['deployShot']>
  lastDeploy: Frame['lastDeploy']
}) {
  const now = useNow(false)
  return (
    <Board
      title="Last deploy"
      span={4}
      aside={
        shot.at === null ? undefined : (
          <span className="text-muted-foreground">
            <Ago at={shot.at} />
          </span>
        )
      }
    >
      {/* The capture's own 16:10 (shot-deploy passes --viewport 1280x800), so
          the whole page is in frame: a frame stretched to the board's height
          cropped its sides. */}
      <a
        className="relative block aspect-16/10 overflow-hidden rounded-lg border border-hairline bg-foreground/[0.04]"
        href={`/api/deploy-shot/${name}?v=${shot.v}`}
        target="_blank"
        rel="noreferrer"
        title={
          (shot.ok
            ? 'Taken right after the last deploy'
            : 'The page ERRORED under the camera right after the last deploy') +
          (shot.at === null || now === null ? '' : ` — ${since((now - shot.at) / 1000)}`)
        }
      >
        <img
          className="absolute inset-0 block size-full object-cover object-top"
          src={`/api/deploy-shot/${name}?v=${shot.v}`}
          alt={`${name} right after its last deploy`}
          loading="lazy"
        />
      </a>
      <Facts list rows={[...lastDeployRows(lastDeploy), pageRow(shot.ok)]} />
    </Board>
  )
}

/** What the camera saw: the norm is quiet, an error is loud. */
function pageRow(ok: boolean) {
  return {
    k: 'page',
    v: ok ? (
      <span className={QUIET}>rendered</span>
    ) : (
      <span className="text-danger [font-weight:550]">errored</span>
    ),
  }
}

/** The running digest and how the last deploy ended — on the picture's board
    when there is one, on Deployment's otherwise. */
function lastDeployRows(lastDeploy: Frame['lastDeploy']) {
  return lastDeploy
    ? [
        {
          k: 'running digest',
          v: <code>{lastDeploy.digest.replace('sha256:', '').slice(0, 12)}</code>,
        },
        {
          k: 'last deploy',
          v:
            lastDeploy.result === 'ok' ? (
              <span className={QUIET}>ok</span>
            ) : (
              <span className="text-danger [font-weight:550]">{lastDeploy.result}</span>
            ),
        },
      ]
    : []
}

/** What is deployed and how it gets there. A failure is the only coloured value. */
export function DeploymentBoard({
  app,
  lastDeploy,
  pullBroken,
  build,
  span,
  withLastDeploy,
}: {
  app: AppRecord
  /** Off when the Last deploy board beside it carries these rows. */
  withLastDeploy: boolean
  lastDeploy: Frame['lastDeploy']
  pullBroken: Frame['pullBroken']
  build: Extract<AppTabData, { kind: 'overview' }>['build']
  span: 4 | 6
}) {
  return (
    <Board
      title="Deployment"
      icon="◲"
      span={span}
      aside={app.sourceMode === 'local' ? null : <RedeployButton name={app.name} />}
    >
      <Facts
        list
        rows={[
          {
            k: 'source',
            v: app.sourceMode === 'local' ? 'local (hot reload)' : 'registry',
          },
          {
            k: 'image',
            v: (
              <code title={app.effectiveImage} className="[overflow-wrap:anywhere]">
                {shortImage(app.effectiveImage)}
              </code>
            ),
          },
          {
            // A push is the real trigger — the box build starts the deploy
            // unit itself — so an app is live in seconds; the timer is the
            // safety net. "Every 2 min" alone had the operator believing the
            // poll was the mechanism.
            k: 'auto-deploy',
            v: (
              <span className={QUIET}>
                {app.sourceMode === 'local' ? 'n/a, source is live' : 'on push · 2-min fallback'}
              </span>
            ),
          },
          ...(withLastDeploy ? lastDeployRows(lastDeploy) : []),
          ...(pullBroken
            ? [
                {
                  k: 'pulls',
                  v: (
                    <span className="text-danger [font-weight:550]">
                      failing, check the registry
                    </span>
                  ),
                },
              ]
            : []),
          { k: 'container', v: <code>app-{app.name}</code> },
        ]}
      />
      {/* What the last box build found in the repo. Nothing at all for an
          app that has never built here. */}
      {build !== null && (
        <div className="border-hairline border-t pt-3">
          <DetectionLine app={app.name} build={build} />
        </div>
      )}
    </Board>
  )
}

/**
 * The clone of this app's repo under ~/projects on the host, where a Claude
 * Code session works on it directly from this box. The host keeps it current
 * — a deploy landing pulls it, a 30-minute timer backstops — so the button is
 * only ever "make it exist" or "don't wait for the timer".
 */
export function WorkspaceBoard({
  repo,
  workspace,
  workspaceRoot,
  span,
  loneOnTablet,
}: {
  repo: Frame['repo']
  workspace: Frame['workspace']
  workspaceRoot: Frame['workspaceRoot']
  span: 4 | 6
  /** The odd third board: on a tablet it fills the row rather than sit beside a gap. */
  loneOnTablet?: boolean
}) {
  return (
    <Board
      title="Workspace"
      icon="⎇"
      span={span}
      spanMd={loneOnTablet === true ? 12 : undefined}
      aside={<CloneButton repo={repo} cloned={workspace !== null} />}
    >
      {workspace ? (
        <Facts
          list
          rows={[
            {
              k: 'repo',
              v: (
                <a
                  href={`https://github.com/${repo}`}
                  target="_blank"
                  rel="noreferrer"
                  className="text-foreground hover:text-primary"
                >
                  {repo}
                </a>
              ),
            },
            {
              k: 'path',
              v: (
                <code className="[overflow-wrap:anywhere]">{`${workspaceRoot}/${workspace.name}`}</code>
              ),
            },
            {
              k: 'checked out',
              v: (
                <code className="[overflow-wrap:anywhere]">
                  {workspace.branch ?? DASH} @ {workspace.head ?? DASH}
                </code>
              ),
            },
            {
              k: 'tree',
              v: workspace.dirty ? (
                <span className="text-warning [font-weight:550]">uncommitted changes</span>
              ) : (
                <span className={QUIET}>clean</span>
              ),
            },
            {
              k: 'vs origin',
              v:
                workspace.ahead === null || workspace.behind === null ? (
                  DASH
                ) : workspace.ahead === 0 && workspace.behind === 0 ? (
                  <span className={QUIET}>current</span>
                ) : (
                  [
                    workspace.ahead > 0 ? `${String(workspace.ahead)} ahead` : null,
                    workspace.behind > 0 ? `${String(workspace.behind)} behind` : null,
                  ]
                    .filter(Boolean)
                    .join(' · ')
                ),
            },
            {
              k: 'last sync',
              v: workspace.sync ? (
                <span
                  className={
                    workspace.sync.result === 'failed' ? 'text-danger [font-weight:550]' : QUIET
                  }
                  title={workspace.sync.detail || undefined}
                >
                  {workspace.sync.result} · <Ago at={workspace.sync.at} />
                </span>
              ) : (
                'not yet'
              ),
            },
          ]}
        />
      ) : (
        <p className={EMPTY}>
          Not cloned on this box.{' '}
          <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">
            {repo}
          </a>{' '}
          would land in <code>{workspaceRoot}</code> and stay current on its own.
        </p>
      )}
    </Board>
  )
}

/**
 * Runs the app's deploy unit now rather than waiting for its 2-minute timer.
 * Same unit either way, so a redeploy that finds an unchanged digest is a
 * no-op — this is not a "restart" button. The host answers when the unit has
 * finished; a refusal (the timer's run is going) or a failure is shown here.
 */
function RedeployButton({ name }: { name: string }) {
  const router = useRouter()
  const { running, answer, start } = useRootAction({
    onSettle: () => {
      void router.invalidate()
    },
  })

  return (
    <span className="inline-flex items-center gap-2.5 text-[0.75rem]">
      {answer !== null && answer.outcome !== 'done' && (
        <span className="text-danger" title={answer.detail || undefined}>
          {answer.outcome === 'refused' ? answer.detail : 'the deploy failed'}
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={GHOST_BTN}
        disabled={running}
        onClick={() => {
          start(() => triggerDeploy({ data: name }))
        }}
      >
        <RotateCwIcon aria-hidden="true" className={running ? 'animate-spin' : undefined} />
        {running ? 'Deploying…' : 'Redeploy'}
      </Button>
    </span>
  )
}
