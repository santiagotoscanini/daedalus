import type { ReactNode } from 'react'
import type { AccessWindow } from '../../lib/access-window'
import type { AppPatch } from '../../lib/apps/validate'
import type { AppTabData } from '../../server/registry'
import { GuardedAwait } from '../error'
import { GrafanaLogs } from '../logs'
import { BlockSkeleton, BoardsSkeleton, StripSkeleton } from '../skeleton'
import { Access } from './access'
import { Database } from './database'
import { Deployments } from './deployments'
import { Overview } from './overview'
import { Secrets } from './secrets'
import { Settings } from './settings'
import type { LoaderData } from './shared'
import { Tasks } from './tasks'
import { Variables } from './variables'
import { Vpn } from './vpn'

// Apps › <name>: one view per tab, as a record keyed by the tab data's
// `kind`, the way a dashboard module's `views` are keyed by its tab ids
// (lib/modules/tabs.ts). A kind without a view is a compile error here, not a
// blank page.
//
// A streamed tab renders behind its skeleton once the loader's `tabData`
// settles; an inline one (settings, logs) reads nothing from it and renders
// at once.

type Kind = AppTabData['kind']
type TabData<K extends Kind> = Extract<AppTabData, { kind: K }>

/** What every tab may read beside its own data: the page's frame and its one write. */
type AppTabContext = {
  frame: NonNullable<LoaderData>
  range: AccessWindow
  /** Saves a field of the registry entry; the page shows a refusal above the tabs. */
  patch: (p: AppPatch) => void
}

type Streamed<K extends Kind> = {
  fallback: ReactNode
  render: (data: TabData<K>, ctx: AppTabContext) => ReactNode
}
type Inline = { fallback: null; render: (ctx: AppTabContext) => ReactNode }

type Inlined = 'settings' | 'logs'

export const APP_TAB_VIEWS: { [K in Kind]: K extends Inlined ? Inline : Streamed<K> } = {
  overview: {
    fallback: (
      <>
        <BlockSkeleton h={86} />
        <BoardsSkeleton spans={[4, 4, 4]} />
      </>
    ),
    render: (d, { frame: f }) => (
      <Overview
        app={f.app}
        status={f.status}
        lastDeploy={f.lastDeploy}
        pullBroken={f.pullBroken}
        deployShot={f.deployShot}
        repo={f.repo}
        workspace={f.workspace}
        workspaceRoot={f.workspaceRoot}
        d={d}
      />
    ),
  },
  deployments: {
    fallback: <BlockSkeleton h={420} />,
    render: (td, { frame }) => <Deployments app={frame.app} td={td} />,
  },
  database: {
    fallback: (
      <>
        <StripSkeleton count={6} />
        <BoardsSkeleton spans={[4, 4, 4]} />
      </>
    ),
    render: (td, { frame }) => <Database app={frame.app} data={td.database} />,
  },
  vpn: {
    fallback: (
      <>
        <StripSkeleton count={4} />
        <BoardsSkeleton spans={[6, 6]} />
      </>
    ),
    render: (td, { frame }) => <Vpn app={frame.app} data={td.vpn} />,
  },
  tasks: {
    fallback: <BlockSkeleton h={300} />,
    render: (td, { frame }) => <Tasks app={frame.app} td={td} />,
  },
  access: {
    fallback: (
      <>
        <StripSkeleton count={4} />
        <BoardsSkeleton spans={[12, 6, 6]} />
      </>
    ),
    render: (td, { frame, range }) => (
      <Access
        name={frame.app.name}
        hostname={frame.app.effectiveHostname}
        stage={frame.app.stage}
        access={td.access}
        range={range}
      />
    ),
  },
  settings: {
    fallback: null,
    render: ({ frame, patch }) => (
      <Settings
        app={frame.app}
        readOnly={frame.app.managedInNix}
        patch={patch}
        takenHostnames={frame.takenHostnames}
        reservedLabels={frame.reservedLabels}
        stateRoot={frame.stateRoot}
      />
    ),
  },
  variables: {
    fallback: <BlockSkeleton h={300} />,
    render: (td, { frame }) => (
      <Variables app={frame.app} readOnly={frame.app.managedInNix} secrets={td.secrets} />
    ),
  },
  secrets: {
    fallback: <BlockSkeleton h={400} />,
    render: (td, { frame }) => (
      <Secrets
        app={frame.app.name}
        env={td.env}
        hasSecretsFile={frame.app.operatorSecrets}
        secrets={td.secrets}
      />
    ),
  },
  // Grafana renders these and does its own querying, so tabData is not read
  // here (lib/apps/tabs.ts says why it is empty). No Panel around it: you are
  // already on the Logs tab, so a box captioned "Logs" inside it is a second
  // label for the same thing.
  logs: {
    fallback: null,
    render: ({ frame }) => (
      <GrafanaLogs
        source={{ container: `app-${frame.app.name}` }}
        title={`${frame.app.name} logs`}
      />
    ),
  },
}

/**
 * The open tab's body. The casts are the one place TS cannot follow: it does
 * not pair a key of the record with its own value's type, so the settled
 * data is handed to the view its `kind` names.
 */
export function TabBody({
  tab,
  tabData,
  resetKey,
  ctx,
}: {
  tab: Kind
  tabData: Promise<AppTabData>
  /** What un-errors a failed body: anything that makes the loader hand over a fresh promise. */
  resetKey: string
  ctx: AppTabContext
}) {
  const view = APP_TAB_VIEWS[tab]
  if (view.fallback === null) return (view as Inline).render(ctx)
  const render = view.render as (d: AppTabData, c: AppTabContext) => ReactNode
  return (
    <GuardedAwait resetKey={resetKey} promise={tabData} fallback={view.fallback}>
      {(td) => (td.kind !== tab ? null : render(td, ctx))}
    </GuardedAwait>
  )
}
