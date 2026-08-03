import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { createServerFn } from '@tanstack/react-start'
import { Bytes, StateDot } from '../components/status'

const getApp = createServerFn()
  .inputValidator((name: string) => name)
  .handler(async ({ data: name }) => {
    const { getApp: fetchApp, driftOf } = await import('../lib/repo/apps')
    const { manifestEntries } = await import('../lib/nix-manifest')
    const { appStatuses, databaseSize, recentLogs, logVolume } = await import('../lib/metrics')

    const record = await fetchApp(name)
    if (!record) return null

    const manifest = (await manifestEntries()).find((m) => m.name === name)

    const [statuses, dbSize, logs, logs1h] = await Promise.all([
      appStatuses([name]),
      record.postgres ? databaseSize(name) : Promise.resolve(null),
      recentLogs(name, 40),
      logVolume(name),
    ])

    return {
      app: {
        name: record.name,
        stage: record.stage,
        managedInNix: record.managedInNix,
        sourceMode: record.sourceMode,
        image: record.image,
        description: record.homepageDescription,
        icon: record.homepageIcon,
        postgres: record.postgres,
        storage: record.storage,
        litellm: record.litellm,
        prometheus: record.prometheus,
        operatorSecrets: record.operatorSecrets,
        authMode: record.authMode,
        authHealthPath: record.authHealthPath,
        authIsolated: record.authIsolated,
        authAllowedGroups: record.authAllowedGroups,
        authBypassRule: record.authBypassRule,
        egressContainer: record.egressContainer,
        egressHostPort: record.egressHostPort,
        notes: record.notes,
        updatedAt: record.updatedAt.toISOString(),
        envVars: record.envVars.map((e) => ({ key: e.key, value: e.value, note: e.note })),
      },
      drift: driftOf(record, manifest),
      status: statuses[name] ?? null,
      dbSize,
      logs1h,
      logs: logs.map((l) => ({ ts: l.ts.toISOString(), level: l.level, line: l.line })),
    }
  })

export const Route = createFileRoute('/apps/$name')({
  loader: async ({ params }) => {
    const data = await getApp({ data: params.name })
    if (!data) throw notFound()
    return data
  },
  component: AppDetail,
  notFoundComponent: () => (
    <>
      <p className="crumbs">
        <Link to="/apps">Apps</Link>
      </p>
      <h1>Not found</h1>
      <p className="lede">No app by that name is in the registry.</p>
    </>
  ),
})

function AppDetail() {
  const { app, drift, status, dbSize, logs, logs1h } = Route.useLoaderData()

  return (
    <>
      <p className="crumbs">
        <Link to="/apps">Apps</Link> <span>›</span> {app.name}
      </p>

      <section className="detail-head">
        <div>
          <h1>
            {app.name}
            <StateDot state={status?.state ?? 'unknown'} />
            <span className="state-label">{status?.state ?? 'unknown'}</span>
            {app.managedInNix && (
              <span className="chip chip-muted" title="Declared by hand in Nix">
                nix-managed
              </span>
            )}
          </h1>
          <p className="lede">{app.description || 'No description.'}</p>
          <p className="links">
            <a href={`https://${app.name}.toscanini.me`} target="_blank" rel="noreferrer">
              {app.name}.toscanini.me
            </a>
            <span className={app.stage === 'live' ? 'chip chip-live' : 'chip chip-lab'}>
              {app.stage === 'live' ? 'external' : 'internal'}
            </span>
          </p>
        </div>
      </section>

      {app.managedInNix && (
        <div className="banner banner-muted">
          Declared by hand in <code>stacks/daedalus/daedalus.nix</code>, not in the registry — so it
          is read-only here. An Apply that broke this entry would take down the interface you would
          use to undo it.
        </div>
      )}

      {drift.length > 0 && (
        <div className="banner">
          <strong>Not applied.</strong> These fields differ from what Nix last built:{' '}
          <code>{drift.join(', ')}</code>
        </div>
      )}

      <div className="cards">
        <Card title="Liveness">
          <Row k="container_up" v={fmtBool(status?.containerUp)} />
          <Row k="health probe" v={fmtBool(status?.healthy)} />
          <Row k="requests" v={status?.rpm === null || !status ? '—' : `${status.rpm.toFixed(1)} rpm`} />
        </Card>

        <Card title="Platform">
          <Row k="stage" v={app.stage} />
          <Row k="source" v={app.sourceMode} />
          <Row k="image" v={app.image ?? `registry.toscanini.me/${app.name}:latest`} mono />
        </Card>

        <Card title="Auth">
          <Row k="mode" v={app.authMode} />
          <Row k="health path" v={app.authHealthPath ?? '—'} mono />
          <Row k="isolated" v={app.authIsolated ? 'yes' : 'no'} />
          <Row k="groups" v={app.authAllowedGroups?.join(', ') ?? 'admins (default)'} />
          {app.authBypassRule && <Row k="bypass" v={app.authBypassRule} mono />}
        </Card>

        <Card title="Data">
          <Row k="postgres" v={app.postgres ? 'shared cluster' : 'no'} />
          {app.postgres && <Row k="db size" v={<Bytes value={dbSize} />} />}
          <Row k="storage" v={app.storage ? '/app/data bind mount' : 'no'} />
          <Row k="operator secrets" v={app.operatorSecrets ? `${app.name}-env.sops` : 'none'} mono />
        </Card>

        <Card title="Integrations">
          <Row k="litellm" v={app.litellm ? 'gateway injected' : 'no'} />
          <Row k="prometheus" v={app.prometheus ? '/metrics scraped' : 'not scraped'} />
          <Row k="logs (1h)" v={logs1h === null ? '—' : String(logs1h)} />
        </Card>

        {app.egressContainer && (
          <Card title="Egress">
            <Row k="netns" v={app.egressContainer} mono />
            <Row k="host port" v={String(app.egressHostPort)} mono />
          </Card>
        )}
      </div>

      {/* Deliberately not a CPU/memory card. Rootless podman puts container
          cgroups where system-level exporters cannot see them, so there is no
          honest per-container figure to show — see src/lib/metrics.ts. */}
      <p className="footnote">
        No per-container CPU or memory: rootless podman hides container cgroups from the node
        exporter, so those series do not exist on this box. Liveness comes from the{' '}
        <code>container_up</code> textfile metric and throughput from traefik.
      </p>

      {app.envVars.length > 0 && (
        <>
          <h2>Environment</h2>
          <table className="env">
            <tbody>
              {app.envVars.map((e) => (
                <tr key={e.key}>
                  <th>
                    <code>{e.key}</code>
                  </th>
                  <td>
                    <code>{e.value}</code>
                    {e.note && <p className="note">{e.note}</p>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}

      {Object.keys(app.notes).length > 0 && (
        <>
          <h2>Notes</h2>
          <dl className="notes">
            {Object.entries(app.notes).map(([k, v]) => (
              <div key={k}>
                <dt>{k}</dt>
                <dd>{v}</dd>
              </div>
            ))}
          </dl>
        </>
      )}

      <h2>Recent logs</h2>
      {logs.length === 0 ? (
        <p className="lede">Nothing in Loki for the last 6 hours.</p>
      ) : (
        <div className="logs">
          {logs.map((l, i) => (
            <div key={`${l.ts}-${String(i)}`} className={`log log-${l.level ?? 'none'}`}>
              <time>{l.ts.slice(11, 23)}</time>
              <span className="lvl">{l.level ?? ''}</span>
              <span className="msg">{l.line}</span>
            </div>
          ))}
        </div>
      )}
    </>
  )
}

function Card({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="card">
      <h2>{title}</h2>
      <dl className="kv">{children}</dl>
    </section>
  )
}

function Row({ k, v, mono }: { k: string; v: React.ReactNode; mono?: boolean }) {
  return (
    <>
      <dt>{k}</dt>
      <dd className={mono ? 'mono' : undefined}>{v}</dd>
    </>
  )
}

function fmtBool(v: boolean | null | undefined): string {
  if (v === null || v === undefined) return 'no data'
  return v ? 'yes' : 'no'
}
