import { Await, createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState, type ReactNode } from 'react'
import { Panel, Segmented, Toggle } from '../components/ui'
import { RowsSkeleton } from '../components/skeleton'
import { appNameError, BASE_DOMAIN, hostnameError } from '../lib/hostname'
import type { Check, Repo } from '../lib/github-repos'
import { createAppFn, fetchAppPreflight, fetchNewAppOptions } from '../server/registry'

// Adding an app.
//
// The platform half of this has always been one entry: stacks/apps turns a
// `fleet.apps.<name>` into a container, a route, DNS, a probe, a database, a
// deploy timer and a CI runner. What was never written down anywhere a person
// could see it is the OTHER half — the repo-side steps in
// stacks/apps/declarations.nix's header comment, which nothing enforces and
// which fail late and confusingly when skipped: an app whose image was never
// published restart-loops, and one whose repo the runner PAT does not cover
// takes its runner unit down with it.
//
// So this page is a checklist first and a form second. It creates a database
// row — the same thing the app's own page edits, shipped by the same Apply —
// and everything else it does is tell you what is not ready yet.
//
// What it deliberately cannot do: create the repo, push the workflows, set
// REGISTRY_PASSWORD, or add the repo to the runner PAT. Each of those needs a
// credential that can change what CI builds, and therefore what this box runs.
// Daedalus reads GitHub; it does not write it.

export const Route = createFileRoute('/apps/new')({
  loader: () => ({ options: fetchNewAppOptions() }),
  component: NewAppPage,
})

type Options = Awaited<ReturnType<typeof fetchNewAppOptions>>
type Preflight = Awaited<ReturnType<typeof fetchAppPreflight>>

function NewAppPage() {
  const { options } = Route.useLoaderData()

  return (
    <>
      <p className="crumbs">
        <Link to="/apps">Apps</Link> <span>›</span> new
      </p>
      <header className="page-head">
        <h1>Add an app</h1>
      </header>
      <p className="lede">
        One repository under <code>github.com/santiagotoscanini</code> becomes one entry in the
        registry. Everything downstream — container, hostname, TLS, DNS, probe, deploy timer, CI
        runner — is derived from it.
      </p>

      <Await promise={options} fallback={<RowsSkeleton count={4} />}>
        {(data) => <Wizard options={data} />}
      </Await>
    </>
  )
}

function Wizard({ options }: { options: Options }) {
  const router = useRouter()

  const [repo, setRepo] = useState<Repo | null>(null)
  const [search, setSearch] = useState('')

  const [description, setDescription] = useState('')
  const [icon, setIcon] = useState('mdi-cube-outline-#94a3b8')
  const [stage, setStage] = useState<'off' | 'lab' | 'live'>('lab')
  const [postgres, setPostgres] = useState(false)
  const [storage, setStorage] = useState(false)
  const [litellm, setLitellm] = useState(false)
  const [prometheus, setPrometheus] = useState(false)
  const [image, setImage] = useState('')
  const [hostname, setHostname] = useState('')

  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [checking, setChecking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // The app key IS the repo name. Not a free field: the default image is
  // `registry.toscanini.me/<name>:latest` and stacks/gha-runner derives the
  // repo it registers a runner for from the same key, so a name that differs
  // from the repo silently points both at something that does not exist. A
  // fork with a different name is what the image override is for.
  const name = repo?.name ?? ''

  const nameErr = repo ? appNameError(name, options.taken) : null
  const hostErr = hostnameError(hostname)

  // Re-check whenever the thing being checked changes. The result is about a
  // (repo, name, image) triple, so keeping a stale one on screen after the
  // image override is edited would be worse than showing none.
  useEffect(() => {
    if (!repo) {
      setPreflight(null)
      return
    }
    let live = true
    setChecking(true)
    void fetchAppPreflight({ data: { repo: repo.name, name, image: image.trim() || null } })
      .then((p) => {
        if (live) setPreflight(p)
      })
      .finally(() => {
        if (live) setChecking(false)
      })
    return () => {
      live = false
    }
  }, [repo, name, image])

  const imageMissing = preflight?.imageState === 'missing'
  const canCreate =
    repo !== null && nameErr === null && hostErr === null && !imageMissing && !busy && !checking

  const create = () => {
    if (!repo) return
    setBusy(true)
    setError(null)
    void createAppFn({
      data: {
        app: {
          name,
          description: description.trim(),
          icon,
          stage,
          postgres,
          storage,
          litellm,
          prometheus,
          image: image.trim() || null,
          hostname: hostname.trim() || null,
        },
      },
    })
      .then(() => {
        // Straight to the app's own page: the entry exists in the database but
        // nothing is running yet, and that page is where the Apply that makes
        // it real lives.
        void router.navigate({ to: '/apps/$name', params: { name }, search: { tab: 'settings' } })
      })
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setBusy(false)
      })
  }

  const visible = options.repos.filter(
    (r) => search === '' || `${r.name} ${r.description ?? ''}`.toLowerCase().includes(search.toLowerCase()),
  )

  return (
    <div className="wizard">
      <section className="wizard-step">
        <h2 className="section-head">
          1 · Repository
          <small>the app key, the image name and the CI runner all come from it</small>
        </h2>

        {options.error !== null && (
          <p className="banner">
            {options.error}. The list below is whatever could be read; you can still create an app
            by picking a repo once GitHub answers again.
          </p>
        )}
        {options.error === null && !options.authenticated && (
          <p className="banner banner-muted">
            No GitHub token in the container’s environment, so this lists <b>public</b>
            repositories only and the checks below that need authentication will say so. The
            fleet’s GitHub credential is rendered by{' '}
            <code>daedalus-dashboard-keys.service</code>; a{' '}
            <code>GITHUB_REPO_TOKEN</code> in <code>stacks/daedalus/service-keys.sops</code>
            overrides it.
          </p>
        )}

        <div className="filters">
          <input
            className="search"
            type="search"
            placeholder="Search repositories…"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value)
            }}
          />
        </div>

        <ul className="repo-list">
          {visible.map((r) => {
            const already = options.taken.includes(r.name)
            return (
              <li key={r.name}>
                <button
                  type="button"
                  className={repo?.name === r.name ? 'repo-row is-picked' : 'repo-row'}
                  disabled={already}
                  title={already ? 'already an app on this box' : undefined}
                  onClick={() => {
                    setRepo(r)
                    // Seed the description from the repo's own, which is
                    // usually the sentence somebody already wrote for it.
                    if (description === '') setDescription(r.description ?? '')
                  }}
                >
                  <span className="repo-name">
                    {r.name}
                    {r.private && <span className="chip chip-muted">private</span>}
                    {r.archived && <span className="chip chip-warn">archived</span>}
                    {already && <span className="chip chip-off">already an app</span>}
                  </span>
                  <span className="repo-desc">{r.description ?? '—'}</span>
                  <span className="repo-meta">
                    {r.language ?? '—'} · {r.pushedAt ? fmtWhen(r.pushedAt) : 'never pushed'}
                  </span>
                </button>
              </li>
            )
          })}
          {visible.length === 0 && <li className="empty">No repositories match that filter.</li>}
        </ul>
      </section>

      {repo && (
        <>
          <section className="wizard-step">
            <h2 className="section-head">
              2 · What it gets
              <small>every one of these is editable afterwards</small>
            </h2>

            {nameErr !== null && <p className="banner">{nameErr}</p>}

            <div className="settings">
              <Panel title="Identity">
                <Field
                  label="Name"
                  value={name}
                  disabled
                  hint={
                    <>
                      The repository name, verbatim. It becomes <code>app-{name}</code>,{' '}
                      <code>
                        {name}.{BASE_DOMAIN}
                      </code>
                      , the postgres role, and the repo the CI runner registers against.
                    </>
                  }
                  onChange={() => undefined}
                />
                <Field
                  label="Description"
                  value={description}
                  placeholder="what it is, in one line"
                  hint="Shown in the app list, on its page, and on the Pocket ID consent screen if it is ever gated."
                  onChange={setDescription}
                />
                <Field
                  label="Icon"
                  value={icon}
                  placeholder="mdi-cube-outline-#94a3b8"
                  hint="mdi-<icon>-#<hex>, the dashboard tile convention."
                  onChange={setIcon}
                />
              </Panel>

              <Panel title="Platform">
                <Toggle
                  checked={postgres}
                  onChange={setPostgres}
                  label="Postgres"
                  hint="Role + database on the shared cluster, injected as DATABASE_URL."
                />
                <Toggle
                  checked={storage}
                  onChange={setStorage}
                  label="Persistent storage"
                  hint="Bind-mounts a data dir at /app/data. What SQLite and file-backed apps need."
                />
                <Toggle
                  checked={litellm}
                  onChange={setLitellm}
                  label="LiteLLM gateway"
                  hint="Injects LITELLM_BASE_URL. Does not hand over the master key."
                />
                <Toggle
                  checked={prometheus}
                  onChange={setPrometheus}
                  label="Prometheus scrape"
                  hint="Only once the app actually serves /metrics — otherwise it is a permanently-down target."
                />
                <p className="panel-note">
                  Not here, on purpose: <b>SSO</b> needs an <code>SSO_SECRET_&lt;NAME&gt;</code> in{' '}
                  <code>stacks/pocket-id/clients.sops</code>, <b>operator secrets</b> need a{' '}
                  <code>{name}-env.sops</code> authored by hand, and <b>VPN egress</b> needs a
                  gluetun instance to exist first. All three are encrypted or declarative state
                  that this app cannot write — add them in the flake, then flip them on the app’s
                  page.
                </p>
              </Panel>

              <Panel title="Exposure">
                <Segmented
                  value={stage}
                  onChange={setStage}
                  options={[
                    { value: 'off', label: 'Off', icon: '⏻' },
                    { value: 'lab', label: 'Internal', icon: '⛨' },
                    { value: 'live', label: 'External', icon: '↗' },
                  ]}
                />
                <p className="panel-note">
                  {stage === 'off' ?
                    'No traefik router, no DNS, no probe — but the container still runs and still deploys.'
                  : stage === 'lab' ?
                    'LAN only: HTTPS through traefik with the wildcard certificate, resolved by pi-hole.'
                  : 'Also published through the Cloudflare tunnel, with a public CNAME. Anyone on the internet can reach it.'}
                </p>
                <Field
                  label="Hostname"
                  value={hostname}
                  placeholder={`${name}.${BASE_DOMAIN}`}
                  validate={(v) => hostnameError(v)}
                  hint={
                    <>
                      Empty uses the default. One level under <code>{BASE_DOMAIN}</code> — the
                      wildcard certificate matches exactly one label.
                    </>
                  }
                  onChange={setHostname}
                />
                <Field
                  label="Image override"
                  value={image}
                  placeholder={`registry.toscanini.me/${name}:latest`}
                  hint="Empty uses the box's own registry, which is what CI publishes to. Set this for a fork, another registry, or a pinned digest."
                  onChange={setImage}
                />
              </Panel>
            </div>
          </section>

          <section className="wizard-step">
            <h2 className="section-head">
              3 · Before it can run
              <small>the repo-side half, checked instead of remembered</small>
            </h2>

            {checking && <p className="banner banner-muted">Checking the repository…</p>}

            {preflight && (
              <ul className="checklist">
                <CheckRow
                  check={{
                    id: 'image',
                    label: 'Image published',
                    state:
                      preflight.imageState === 'present' ? 'ok'
                      : preflight.imageState === 'missing' ? 'bad'
                      : 'unknown',
                    detail:
                      preflight.imageState === 'present' ?
                        `${preflight.effectiveImage} is in the registry`
                      : preflight.imageState === 'missing' ?
                        `${preflight.effectiveImage} does not exist yet`
                      : `${preflight.effectiveImage} is not on this box's registry — cannot be checked from here`,
                    fix:
                      preflight.imageState === 'missing' ?
                        'Run the image workflow once. Until the image exists, the container would restart-loop from the moment this entry is applied — which is why this is the one check that blocks.'
                      : undefined,
                  }}
                />
                {preflight.checks.map((c) => (
                  <CheckRow key={c.id} check={c} />
                ))}
                <CheckRow
                  check={{
                    id: 'runner-pat',
                    label: 'CI runner credential',
                    state: 'ok',
                    detail:
                      'The PAT in stacks/gha-runner/env.sops covers every repository on the account, so declaring the app is all its runner needs.',
                    fix: 'If the runner unit ever fails ExecStartPre with a 404, that PAT’s repository access is the thing to check — daedalus cannot see it from here.',
                  }}
                />
              </ul>
            )}

            {error !== null && <p className="banner">{error}</p>}

            <div className="wizard-actions">
              <button type="button" className="btn btn-primary" disabled={!canCreate} onClick={create}>
                {busy ? 'Creating…' : 'Create entry'}
              </button>
              <p className="footnote">
                {imageMissing ?
                  'Blocked until the image exists — everything else on this page is already saved nowhere, so come back after CI runs.'
                : 'Writes the registry row. Nothing is built, routed or started until you Apply, which commits stacks/apps/apps.json and rebuilds.'}
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

function CheckRow({ check }: { check: Check }) {
  const mark =
    check.state === 'ok' ? '✓'
    : check.state === 'bad' ? '✗'
    : check.state === 'warn' ? '!'
    : '?'

  return (
    <li className={`check check-${check.state}`}>
      <span className="check-mark" aria-hidden="true">
        {mark}
      </span>
      <span className="check-body">
        <b>{check.label}</b>
        <span className="check-detail">{check.detail}</span>
        {check.fix !== undefined && <span className="check-fix">{check.fix}</span>}
      </span>
    </li>
  )
}

/**
 * A plain controlled field.
 *
 * Not the TextField from the app detail page: that one saves on blur because
 * it edits a record that already exists, and every keystroke here belongs to a
 * form that has not been submitted yet.
 */
function Field({
  label,
  value,
  placeholder,
  hint,
  disabled,
  validate,
  onChange,
}: {
  label: string
  value: string
  placeholder?: string
  hint?: ReactNode
  disabled?: boolean
  validate?: (v: string) => string | null
  onChange: (v: string) => void
}) {
  const error = validate ? validate(value) : null
  return (
    <label className={error === null ? 'field' : 'field field-bad'}>
      <span>{label}</span>
      <input
        type="text"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== null}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
      {error !== null ?
        <small className="field-error">{error}</small>
      : hint !== undefined && <small className="field-hint">{hint}</small>}
    </label>
  )
}

function fmtWhen(iso: string): string {
  const days = Math.round((Date.now() - new Date(iso).getTime()) / 86_400_000)
  if (days < 1) return 'pushed today'
  if (days < 30) return `pushed ${String(days)}d ago`
  return `pushed ${iso.slice(0, 7)}`
}
