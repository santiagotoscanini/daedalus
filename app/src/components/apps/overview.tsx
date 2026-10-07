import { cn } from '../../lib/cn'
import { DASH, num } from '../../lib/format'
import type { AppTabData } from '../../server/registry'
import { ExplainToggle } from '../explain'
import { SECTION_TITLE } from '../table'
import { Board, BoardGrid, Stat, StatStrip } from '../viz'
import { DeploymentBoard, PreviewBoard, WorkspaceBoard } from './overview-boards'
import type { AppRecord, LoaderData } from './shared'

export function Overview({
  app,
  status,
  lastDeploy,
  pullBroken,
  deployShot,
  repo,
  workspace,
  workspaceRoot,
  d,
}: {
  app: AppRecord
  status: NonNullable<LoaderData>['status']
  lastDeploy: NonNullable<LoaderData>['lastDeploy']
  pullBroken: NonNullable<LoaderData>['pullBroken']
  deployShot: NonNullable<LoaderData>['deployShot']
  repo: NonNullable<LoaderData>['repo']
  workspace: NonNullable<LoaderData>['workspace']
  workspaceRoot: NonNullable<LoaderData>['workspaceRoot']
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

  const healthy = status?.healthy ?? null
  const oomKills = d.resources.oomKills
  const oom = oomKills !== null && oomKills > 0
  const span = deployShot === null ? 6 : 4

  return (
    <>
      {/* The page's one focal reading: six numbers in the order you would ask
          them — is it up, is anyone using it, what is it costing, is it being
          noisy. Their working folds behind the ⓘ rather than sitting under the
          strip as a paragraph nobody reads twice. */}
      <h2 className={cn(SECTION_TITLE, 'mt-0 gap-x-1')}>
        Last hour
        <ExplainToggle
          className="-my-1 inline-flex"
          content={
            <p>
              CPU and memory come from cgroup v2 at 60-second resolution. Memory is{' '}
              <code>memory.current</code>, which counts page cache, so an app doing file I/O sits at
              its limit and is fine. The signal that a cap is too tight is the OOM counter moving.
            </p>
          }
        />
      </h2>
      <StatStrip>
        {/* The probe, not the container state — the head above already
            carries running/stopped. Only a failing probe takes a colour:
            "ok" is the norm and reads in plain ink. */}
        <Stat
          label="Health"
          value={healthy === null ? 'not probed' : healthy ? 'ok' : 'failing'}
          tone={healthy === false ? 'bad' : healthy === null ? 'muted' : undefined}
          sub={status?.containerUp === false ? 'container down' : 'probed every 60s'}
          title={`gatus probes ${app.authHealthPath ?? '/'} from outside every 60s. Container liveness: ${fmtBool(status?.containerUp)}.`}
        />
        <Stat
          label="Requests"
          value={status?.rpm === null || !status ? DASH : status.rpm.toFixed(1)}
          unit="/min"
          tone={status?.rpm === null || !status ? 'muted' : undefined}
          spark={status?.spark ?? []}
          sub="last hour"
        />
        <Stat
          label="CPU"
          value={d.resources.cpu.used === null ? DASH : d.resources.cpu.used.toFixed(2)}
          unit={d.resources.cpu.limit === null ? 'cores' : `of ${String(d.resources.cpu.limit)}`}
          spark={d.resources.cpu.spark}
          tone={d.resources.cpu.used === null ? 'muted' : undefined}
          title="cgroup v2, 60-second resolution"
        />
        <Stat
          label="Memory"
          value={d.resources.memory.used === null ? DASH : fmtMb(d.resources.memory.used)}
          unit={d.resources.memory.limit === null ? 'MB' : `of ${fmtMb(d.resources.memory.limit)}`}
          spark={d.resources.memory.spark}
          tone={d.resources.memory.used === null ? 'muted' : undefined}
          title="memory.current counts page cache: an app doing file I/O sits at its limit and is fine"
        />
        <Stat
          label="Processes"
          value={d.resources.pids.used === null ? DASH : String(d.resources.pids.used)}
          unit={d.resources.pids.limit === null ? '' : `of ${String(d.resources.pids.limit)}`}
          // The OOM counter is the one reading here that can be a fault,
          // so it is the one allowed to take a colour — and it replaces
          // the caption rather than sitting beside it, because "no OOM
          // kills" is not news and "3 OOM kills" is.
          tone={oom ? 'bad' : d.resources.pids.used === null ? 'muted' : undefined}
          sub={oom ? `${String(oomKills)} OOM kill${oomKills === 1 ? '' : 's'}` : 'no OOM kills'}
        />
        <Stat
          label="Logs"
          value={d.logs1h === null ? DASH : d.logs1h.toLocaleString('en-US')}
          tone={d.logs1h === null ? 'muted' : undefined}
          unit="/hour"
          sub="shipped to Loki"
        />
      </StatStrip>

      <div className="mt-6">
        <BoardGrid>
          {/* Three boards of one height when there is a picture of the last
            deploy: the picture fills its board, so it never leaves the tall/
            short pair the two fact lists used to make beside it. */}
          {deployShot !== null && (
            <PreviewBoard name={app.name} shot={deployShot} lastDeploy={lastDeploy} />
          )}
          <DeploymentBoard
            app={app}
            withLastDeploy={deployShot === null}
            lastDeploy={lastDeploy}
            pullBroken={pullBroken}
            build={d.build}
            span={span}
          />
          {/* No Database, Access or VPN boards here: each is a section in
            the app rail with a fuller page, and the overview repeating their
            facts was the rail's list restated as cards. */}
          <WorkspaceBoard
            repo={repo}
            workspace={workspace}
            workspaceRoot={workspaceRoot}
            span={span}
          />

          {notes.length > 0 && (
            <Board title="Why it is configured this way" icon="✎" span={12}>
              {/* Columns rather than one stack: these are several short
                rationales, not one long document, and full-width paragraphs in
                a 12-span board leave most of the row empty. */}
              <dl className="m-0 grid grid-cols-[repeat(auto-fit,minmax(18rem,1fr))] gap-x-7 gap-y-4">
                {notes.map(([k, v]) => (
                  <div key={k} className="min-w-0">
                    <dt className="text-[0.75rem] font-[550] text-muted-foreground">{k}</dt>
                    <dd className="mt-1 mr-0 mb-0 ml-0 text-[0.875rem] leading-[1.55] text-subdued">
                      {v}
                    </dd>
                  </div>
                ))}
              </dl>
            </Board>
          )}
        </BoardGrid>
      </div>
    </>
  )
}

function fmtBool(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return 'no data'
  return v ? 'yes' : 'no'
}

/** Bytes → whole MB. MiB, matching what --memory takes and cgroup enforces. */
function fmtMb(bytes: number): string {
  return num(Math.round(bytes / (1024 * 1024)))
}
