import { useRouter } from '@tanstack/react-router'
import type { DeployStatus } from '../../lib/deploy'
import { DASH, since } from '../../lib/format'
import { type AppTabData, fetchDeployStatus, triggerDeploy } from '../../server/registry'
import { usePolledStatus } from '../status'
import { Bytes } from '../ui'
import { Board, BoardGrid, Facts, Stat, StatStrip } from '../viz'
import { CloneButton } from '../workspace'
import type { AppRecord, LoaderData } from './shared'

/** The auth mode as a person would say it, not as the column stores it. */
const AUTH_WORD: Record<string, string> = {
  none: 'none',
  proxy: 'forward-auth',
  native: 'app is the client',
}

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

export function Overview({
  app,
  status,
  deployStatus,
  lastDeploy,
  pullBroken,
  repo,
  workspace,
  workspaceRoot,
  workspaceStatus,
  d,
}: {
  app: AppRecord
  status: NonNullable<LoaderData>['status']
  deployStatus: NonNullable<LoaderData>['deployStatus']
  lastDeploy: NonNullable<LoaderData>['lastDeploy']
  pullBroken: NonNullable<LoaderData>['pullBroken']
  repo: NonNullable<LoaderData>['repo']
  workspace: NonNullable<LoaderData>['workspace']
  workspaceRoot: NonNullable<LoaderData>['workspaceRoot']
  workspaceStatus: NonNullable<LoaderData>['workspaceStatus']
  d: Extract<AppTabData, { kind: 'overview' }>
}) {
  // `notes` is jsonb, so the database can hand back anything — an array, a
  // nested object, a number. Rendering an unexpected value throws
  // "Objects are not valid as a React child" and takes down the WHOLE page,
  // which is precisely the page you would use to fix the bad record. Coerce
  // to string pairs and keep going; a mangled note shows as text, not a 500.
  const notes: [string, string][] = Object.entries(
    (app.notes ?? {}) as Record<string, unknown>,
  ).map(([k, v]) => [k, typeof v === 'string' ? v : JSON.stringify(v)])

  return (
    <>
      {/* Six readings in the order you would ask them: is it up, is anyone
          using it, what is it costing, is it being noisy. */}
      <StatStrip>
        {/* The probe, not the container state — the hero above already
            carries running/stopped, and a second copy of it here would
            spend a cell of the strip agreeing with itself. */}
        <Stat
          label="Health"
          value={
            status?.healthy === undefined || status.healthy === null
              ? 'not probed'
              : status.healthy
                ? 'ok'
                : 'failing'
          }
          tone={
            status?.healthy === undefined || status.healthy === null
              ? undefined
              : status.healthy
                ? 'ok'
                : 'bad'
          }
          sub={status?.containerUp === false ? 'container down' : 'probed every 60s'}
          title={`gatus probes ${app.authHealthPath ?? '/'} from outside every 60s. Container liveness: ${fmtBool(status?.containerUp)}.`}
        />
        <Stat
          label="Requests"
          value={status?.rpm === null || !status ? DASH : status.rpm.toFixed(1)}
          unit="/min"
          spark={status?.spark ?? []}
          sub="last hour"
        />
        <Stat
          label="CPU"
          value={d.resources.cpu.used === null ? DASH : d.resources.cpu.used.toFixed(2)}
          unit={d.resources.cpu.limit === null ? 'cores' : `of ${String(d.resources.cpu.limit)}`}
          spark={d.resources.cpu.spark}
        />
        <Stat
          label="Memory"
          value={d.resources.memory.used === null ? DASH : fmtMb(d.resources.memory.used)}
          unit={d.resources.memory.limit === null ? 'MB' : `of ${fmtMb(d.resources.memory.limit)}`}
          spark={d.resources.memory.spark}
        />
        <Stat
          label="Processes"
          value={d.resources.pids.used === null ? DASH : String(d.resources.pids.used)}
          unit={d.resources.pids.limit === null ? '' : `of ${String(d.resources.pids.limit)}`}
          // The OOM counter is the one reading here that can be a fault,
          // so it is the one allowed to take a colour — and it replaces
          // the caption rather than sitting beside it, because "no OOM
          // kills" is not news and "3 OOM kills" is.
          tone={d.resources.oomKills !== null && d.resources.oomKills > 0 ? 'bad' : undefined}
          sub={
            d.resources.oomKills !== null && d.resources.oomKills > 0
              ? `${String(d.resources.oomKills)} OOM kill${d.resources.oomKills === 1 ? '' : 's'}`
              : 'no OOM kills'
          }
        />
        <Stat
          label="Logs"
          value={d.logs1h === null ? DASH : d.logs1h.toLocaleString('en-US')}
          unit="/hour"
          sub="shipped to Loki"
        />
      </StatStrip>

      <p className="strip-foot">
        CPU and memory come from cgroup v2 at 60-second resolution. Memory is{' '}
        <code>memory.current</code>, which counts page cache, so an app doing file I/O sits at its
        limit and is fine. The signal that a cap is too tight is the OOM counter moving.
      </p>

      <BoardGrid>
        <Board
          title="Deployment"
          icon="◲"
          span={4}
          aside={
            app.sourceMode === 'local' ? null : (
              <RedeployButton name={app.name} initial={deployStatus} />
            )
          }
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
                v: <code title={app.effectiveImage}>{shortImage(app.effectiveImage)}</code>,
              },
              {
                k: 'auto-deploy',
                v: app.sourceMode === 'local' ? 'n/a, source is live' : 'every 2 min',
              },
              ...(lastDeploy
                ? [
                    {
                      k: 'running digest',
                      v: <code>{lastDeploy.digest.replace('sha256:', '').slice(0, 12)}</code>,
                    },
                    {
                      k: 'last deploy',
                      v: (
                        <span className={lastDeploy.result === 'ok' ? 'ok-text' : 'bad-text'}>
                          {lastDeploy.result}
                        </span>
                      ),
                    },
                  ]
                : []),
              ...(pullBroken
                ? [
                    {
                      k: 'pulls',
                      v: <span className="bad-text">failing, check the registry</span>,
                    },
                  ]
                : []),
              { k: 'container', v: <code>app-{app.name}</code> },
            ]}
          />
        </Board>

        <Board title="Database" icon="◧" span={4}>
          {app.postgres ? (
            <Facts
              list
              rows={[
                { k: 'cluster', v: 'shared pg' },
                { k: 'database', v: <code>{app.name}</code> },
                { k: 'size', v: <Bytes value={d.dbSize} /> },
                { k: 'host', v: <code>pg:5432</code> },
              ]}
            />
          ) : (
            <p className="viz-empty">No database. Enable Postgres in Settings.</p>
          )}
        </Board>

        <Board title="Access" icon="⛨" span={4}>
          <Facts
            list
            rows={[
              { k: 'auth', v: AUTH_WORD[app.authMode] ?? app.authMode },
              { k: 'health path', v: <code>{app.authHealthPath ?? DASH}</code> },
              { k: 'isolated', v: app.authIsolated ? 'yes' : 'no' },
              { k: 'groups', v: app.authAllowedGroups?.join(', ') ?? 'admins' },
              {
                k: 'secrets',
                v: app.operatorSecrets ? (
                  <code>{app.name}-env.sops</code>
                ) : (
                  <span className="muted">none</span>
                ),
              },
            ]}
          />
        </Board>

        {/* The clone of this app's repo under ~/projects on the host, where a
            Claude Code session works on it directly from this box. The host
            keeps it current — a deploy landing pulls it, a 30-minute timer
            backstops — so the button is only ever "make it exist" or "don't
            wait for the timer". */}
        <Board
          title="Workspace"
          icon="⎇"
          span={4}
          aside={<CloneButton repo={repo} cloned={workspace !== null} initial={workspaceStatus} />}
        >
          {workspace ? (
            <Facts
              list
              rows={[
                {
                  k: 'repo',
                  v: (
                    <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">
                      {repo}
                    </a>
                  ),
                },
                {
                  k: 'path',
                  v: <code>{`${workspaceRoot}/${workspace.name}`}</code>,
                },
                {
                  k: 'checked out',
                  v: (
                    <code>
                      {workspace.branch ?? DASH} @ {workspace.head ?? DASH}
                    </code>
                  ),
                },
                {
                  k: 'tree',
                  v: workspace.dirty ? (
                    <span className="warn-text">uncommitted changes</span>
                  ) : (
                    'clean'
                  ),
                },
                {
                  k: 'vs origin',
                  v:
                    workspace.ahead === null || workspace.behind === null
                      ? DASH
                      : workspace.ahead === 0 && workspace.behind === 0
                        ? 'current'
                        : [
                            workspace.ahead > 0 ? `${String(workspace.ahead)} ahead` : null,
                            workspace.behind > 0 ? `${String(workspace.behind)} behind` : null,
                          ]
                            .filter(Boolean)
                            .join(' · '),
                },
                {
                  k: 'last sync',
                  v: workspace.sync ? (
                    <span
                      className={workspace.sync.result === 'failed' ? 'bad-text' : undefined}
                      title={workspace.sync.detail || undefined}
                    >
                      {workspace.sync.result} ·{' '}
                      {since((Date.now() - Date.parse(workspace.sync.at)) / 1000)}
                    </span>
                  ) : (
                    'not yet'
                  ),
                },
              ]}
            />
          ) : (
            <p className="viz-empty">
              Not cloned on this box.{' '}
              <a href={`https://github.com/${repo}`} target="_blank" rel="noreferrer">
                {repo}
              </a>{' '}
              would land in <code>{workspaceRoot}</code> and stay current on its own.
            </p>
          )}
        </Board>

        {app.egressContainer && (
          <Board title="Egress" icon="⇄" span={4}>
            <Facts
              list
              rows={[
                { k: 'netns', v: <code>{app.egressContainer}</code> },
                { k: 'host port', v: <code>{String(app.egressHostPort)}</code> },
                { k: 'outbound', v: 'all through the VPN' },
              ]}
            />
          </Board>
        )}

        {notes.length > 0 && (
          <Board title="Why it is configured this way" icon="✎" span={12}>
            <dl className="notes">
              {notes.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </Board>
        )}
      </BoardGrid>
    </>
  )
}

/**
 * Runs the app's deploy unit now rather than waiting for its 2-minute timer.
 * Same unit either way, so a redeploy that finds an unchanged digest is a
 * no-op — this is not a "restart" button.
 */
function RedeployButton({ name, initial }: { name: string; initial: DeployStatus }) {
  const router = useRouter()
  const { status, running, start } = usePolledStatus({
    initial,
    fetch: () => fetchDeployStatus(),
    onSettle: () => {
      void router.invalidate()
    },
  })

  return (
    <span className="redeploy">
      {status.state === 'failed' && status.app === name && (
        <span className="bad-text" title={status.error}>
          last attempt failed
        </span>
      )}
      <button
        type="button"
        className="btn btn-ghost"
        disabled={running}
        onClick={() => {
          start(async () => (await triggerDeploy({ data: name })).id)
        }}
      >
        {running ? '↻ deploying…' : '↻ Redeploy'}
      </button>
    </span>
  )
}

function fmtBool(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return 'no data'
  return v ? 'yes' : 'no'
}

/** Bytes → whole MB. MiB, matching what --memory takes and cgroup enforces. */
function fmtMb(bytes: number): string {
  return Math.round(bytes / (1024 * 1024)).toLocaleString()
}
