import { appAccess, noAccess } from '../../host/access'
import { lastDeploy } from '../../host/deploy'
import { readEnvSnapshot } from '../../host/env-snapshot'
import {
  activityLog,
  appDatabase,
  appResources,
  appVpn,
  databaseSize,
  logVolume,
  NO_DATABASE,
  NO_RESOURCES,
  NO_VPN,
} from '../../host/metrics'
import { operatorSecretApps } from '../../host/nix-manifest'
import { commitUrl } from '../../host/registry'
import { readSite } from '../../host/site'
import { readTaskRunStatus, type TaskRunStatus } from '../../host/task-run'
import type { AccessWindow } from '../access-window'
import type { ActivityRow } from '../activity-lines'
import { logTime } from '../format'
import { effectiveHostname } from '../hostname'
import { getApp } from '../repo/apps'
import { overviewBuild, recentBuilds } from '../repo/build-views'
import { ingestDeployments, listDeployments } from '../repo/deployments'
import type { AppSecretKey } from './secret-keys'
import { loadAppSecrets } from './secrets'
import { loadTasksTab, type TasksPayload } from './tasks'

// The app detail page's tab bodies — one branch per tab, and nothing a tab
// does not need.
//
// Split from ./detail.ts because the two have completely different costs. The
// frame is tens of milliseconds and the page cannot draw without it; these are
// nine prometheus queries (overview), ten Loki ones (access) or sixteen
// (database), and every one of them streams in behind a skeleton.
//
// Static imports, not the seam's dynamic ones: `src/lib/apps/` is a server
// region (host/boundary.test.ts), so nothing here can reach a browser, and the
// whole module is loaded by one `await import` in server/registry.ts.

/**
 * Everything one tab of the app detail page needs, and nothing another one
 * does.
 *
 * The route calls this WITHOUT awaiting it, so the frame is on screen while
 * this runs and each tab body streams in behind a skeleton. That is what makes
 * the expensive tabs affordable: `overview` is nine prometheus queries,
 * `access` is ten Loki ones, `database` sixteen. None of them ever delays the
 * page, and switching tabs re-runs exactly one of them.
 *
 * Discriminated by `kind` so a tab cannot read another tab's payload — the
 * union is what stops a future edit from rendering `access` data on the logs
 * tab and getting a runtime undefined instead of a type error.
 */
export type AppTabData =
  | {
      kind: 'overview'
      resources: AppResources
      dbSize: number | null
      logs1h: number | null
      /** The last successful box build, for the detection line; null when there is none. */
      build: {
        summary: import('../build-display').BuildSummary
        detection: import('../build-detect').Detection | null
        warningCount: number
      } | null
    }
  | {
      kind: 'deployments'
      activity: ActivityRow[]
      deployments: DeployRow[]
      /** Box builds, newest first (lib/repo/builds.ts). */
      builds: import('../build-display').BuildSummary[]
    }
  | { kind: 'access'; access: AppAccess }
  | { kind: 'secrets'; env: EnvPayload; secrets: AppSecretKey[] }
  /**
   * The variables themselves come with the FRAME (`app.envVars`), because
   * that is what the editor edits — the same reason the task list is there.
   * What the tab fetches is the SECRET key names, which the form needs to
   * refuse a name that is already sealed in the sops file.
   */
  | { kind: 'variables'; secrets: AppSecretKey[] }
  | { kind: 'logs' }
  | { kind: 'database'; database: AppDatabase }
  | { kind: 'vpn'; vpn: AppVpn }
  | {
      kind: 'tasks'
      tasks: TasksPayload
      /**
       * The run bridge's current state, so the Run now button starts from what
       * the box is actually doing rather than from `idle` — a page opened
       * while a task is running shows that run instead of offering to start a
       * second one.
       */
      runStatus: TaskRunStatus
    }
  | { kind: 'settings' }

type AppResources = Awaited<ReturnType<typeof appResources>>
type AppDatabase = Awaited<ReturnType<typeof appDatabase>>
type AppVpn = Awaited<ReturnType<typeof appVpn>>
type AppAccess = Awaited<ReturnType<typeof appAccess>>
type EnvSnapshotVar = Awaited<ReturnType<typeof readEnvSnapshot>>['vars'][number]
type EnvPayload = {
  available: boolean
  takenAt: string | null
  // `origin` and `group` keep their union types rather than widening to
  // string: the UI switches on them, and a widened string would let a typo
  // through to a missing label at runtime.
  vars: (Pick<EnvSnapshotVar, 'key' | 'origin' | 'group' | 'secret'> & {
    note: string | null
    value: string | null
  })[]
}
type DeployRow = {
  id: string
  digest: string
  result: string
  httpCode: string | null
  startedAt: string
  durationMs: number
  revision: string | null
  shortRevision: string | null
  commitUrl: string | null
  imageCreatedAt: string | null
  isCurrent: boolean
}

/**
 * The body of one tab, and nothing another tab needs.
 *
 * The route calls the server function in front of this WITHOUT awaiting it,
 * so the page frame is on screen while this runs and each tab streams in
 * behind a skeleton. Switching tabs re-runs exactly one of these branches.
 */
export async function loadAppTab(data: {
  name: string
  tab: string
  accessWindow: AccessWindow
}): Promise<AppTabData> {
  const { name, tab, accessWindow } = data

  const record = await getApp(name)
  if (!record) return { kind: 'settings' }

  switch (tab) {
    case 'overview': {
      const [resources, dbSize, logs1h, build] = await Promise.all([
        appResources(name).catch(() => NO_RESOURCES),
        record.postgres ? databaseSize(name) : Promise.resolve(null),
        logVolume(name),
        // The detection line is not worth the overview.
        overviewBuild(record.id).catch(() => null),
      ])
      return { kind: 'overview', resources, dbSize, logs1h, build }
    }

    case 'deployments': {
      // Fold deploy.sh's journal into Postgres before reading it back. Done
      // on demand here; the build reporter (core/builds/report.ts) also
      // ingests an app's journal on its own tick while a GitHub Deployment
      // waits for its deploy to land. Ingest is idempotent, so both may run.
      await ingestDeployments(record.id, name)
      const [deploys, activity, deploy, builds] = await Promise.all([
        listDeployments(record.id),
        activityLog(name, 60),
        lastDeploy(name),
        record.sourceMode === 'local' ? Promise.resolve([]) : recentBuilds(record.id, 10),
      ])
      return {
        kind: 'deployments',
        builds,
        // `at` is formatted HERE rather than in the component: `logTime`
        // reads the clock and the timezone, and a browser in either a
        // different zone or on the other side of midnight from the box
        // formats the same instant differently — which is a hydration
        // mismatch, and a whole-document one because it is text.
        activity: activity.map((l) => ({
          ts: l.ts.toISOString(),
          at: logTime(l.ts.toISOString()),
          line: l.line,
        })),
        deployments: deploys.map((d) => ({
          id: d.id,
          digest: d.digest.replace('sha256:', ''),
          result: d.result,
          httpCode: d.httpCode,
          startedAt: d.startedAt.toISOString(),
          durationMs: d.durationMs,
          revision: d.revision,
          shortRevision: d.revision ? d.revision.slice(0, 8) : null,
          commitUrl: commitUrl(d.sourceUrl, d.revision),
          imageCreatedAt: d.imageCreatedAt ? d.imageCreatedAt.toISOString() : null,
          isCurrent: deploy ? d.digest === deploy.digest : false,
        })),
      }
    }

    case 'access': {
      // Gated on the app actually being published through the tunnel:
      // `stage != live` means there is no cfweb traffic to find, so the ten
      // queries would all be a round trip to confirm zero.
      const access =
        record.stage === 'live'
          ? await appAccess(
              effectiveHostname(readSite(), record.name, record.hostname),
              accessWindow,
            ).catch(() => noAccess(accessWindow))
          : noAccess(accessWindow)
      return { kind: 'access', access }
    }

    case 'variables':
      return { kind: 'variables', secrets: await loadAppSecrets(name) }

    case 'secrets': {
      // Secret VALUES are deliberately NOT in this payload. Loader data is
      // serialised into the HTML, so shipping them and masking with CSS
      // would put every database password in view-source — theatre, not
      // concealment. The reveal button fetches one value at a time.
      const declared = new Map(record.envVars.map((e) => [e.key, e.note]))
      const snapshot = await readEnvSnapshot(
        name,
        declared,
        (await operatorSecretApps()).includes(name),
      )
      return {
        kind: 'secrets',
        // The KEYS of the operator-secrets file, read off its ciphertext — the
        // one thing about it this container can know. What the env snapshot
        // labels `origin: secrets` is an inference from "the app has a file and
        // nothing else claims this name"; this is the file itself, so it also
        // lists a key the container has not picked up yet (set since its last
        // start) and drops one the file no longer holds.
        secrets: await loadAppSecrets(name),
        env: {
          available: snapshot.available,
          takenAt: snapshot.takenAt,
          vars: snapshot.vars.map((v) => ({
            key: v.key,
            origin: v.origin,
            group: v.group,
            secret: v.secret,
            note: v.note ?? null,
            value: v.secret ? null : v.value,
          })),
        },
      }
    }

    // Nothing to fetch: the tab frames a Grafana panel that queries Loki
    // itself, so pulling sixty lines through here would be a round trip
    // whose result is serialised into the page and never rendered.
    case 'logs':
      return { kind: 'logs' }

    case 'database': {
      // Gated on the app actually having a database: without it every app
      // without postgres would pay for sixteen round trips to be told that
      // `pg_database_size_bytes{datname="…"}` matches nothing.
      return {
        kind: 'database',
        database: record.postgres ? await appDatabase(name).catch(() => NO_DATABASE) : NO_DATABASE,
      }
    }

    // Cheap on purpose: the declared tasks come from the record the frame
    // already read, and the run facts from a snapshot that is cached for a
    // minute. Nothing here is a query, which is why there is no gate on the
    // app having tasks — the answer for an app with none is an empty list,
    // and the rail hides the tab anyway.
    case 'tasks': {
      const [tasks, runStatus] = await Promise.all([loadTasksTab(name), readTaskRunStatus()])
      return { kind: 'tasks', tasks, runStatus }
    }

    case 'vpn': {
      return {
        kind: 'vpn',
        vpn:
          record.egressContainer === null
            ? NO_VPN
            : await appVpn(record.egressContainer).catch(() => NO_VPN),
      }
    }

    default:
      // Settings edits the record the frame already carries — there is
      // nothing further to fetch, and no request is made.
      return { kind: 'settings' }
  }
}
