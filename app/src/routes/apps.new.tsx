import { createFileRoute, Link, useRouter } from '@tanstack/react-router'
import { type ReactNode, useEffect, useId, useState } from 'react'
import { ReadinessPanel } from '../components/apps/readiness'
import { RepoPicker } from '../components/apps/repo-picker'
import { BOARD_FOOT, SECTION_HEAD, SECTION_HEAD_SMALL } from '../components/apps/shared'
import { Toggle } from '../components/controls'
import { GuardedAwait } from '../components/error'
import { Crumbs, PageHead } from '../components/page'
import { NewAppSkeleton } from '../components/skeleton'
import { Alert, AlertDescription } from '../components/ui/alert'
import { Button } from '../components/ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '../components/ui/field'
import { Input } from '../components/ui/input'
import { Board, BoardGrid } from '../components/viz'
import type { Repo } from '../host/github-repos'
import { cn } from '../lib/cn'
import { appNameError, hostnameError } from '../lib/hostname'
import { readiness } from '../lib/readiness'
import { errorText } from '../lib/redact'
import { defaultImage } from '../lib/site'
import { useSite } from '../lib/site-context'
import { createAppFn, fetchAppPreflight, fetchNewAppOptions } from '../server/registry'

// Adding an app.
//
// The platform half of this has always been one entry: stacks/apps turns a
// `fleet.apps.<name>` into a container, a route, DNS, a probe, a database and
// a deploy timer. The part that used to fail late and confusingly is that an
// app whose image was never published restart-loops from the moment its entry
// is applied, which fails the switch, which makes the Apply revert itself.
//
// This page answered that by refusing to create the entry until an image
// existed — which was a deadlock, because the box only builds apps already in
// site/apps.json. The fix is the `declared` stage: an entry that materializes
// the app's database, data dir and secrets and runs NOTHING. So this form
// writes the row, always declared, and the order is
//
//   create (declared) → Apply → build → promote to internal/external → Apply
//
// with the promotion offered on the app's own page once the build lands.
// Step 3 below reports what the box will find when it builds the repo. It
// gates nothing: no fact about a repository is a reason to refuse a row that
// starts nothing.
//
// What this page deliberately cannot do: create the repo or push to it.
// Daedalus reads GitHub; it does not write it.

export const Route = createFileRoute('/apps/new')({
  loader: () => ({ options: fetchNewAppOptions() }),
  component: NewAppPage,
})

type Options = Awaited<ReturnType<typeof fetchNewAppOptions>>
type Preflight = Awaited<ReturnType<typeof fetchAppPreflight>>

/* The flow's vertical rhythm lives here, not on the steps. Each step opens
   with a section head, whose top rule and 2.5rem margin already separate it
   from the step above — so the only two edges left are the wizard's own: the
   gap under the lede, and a first step that must NOT draw that rule, where it
   would read as an underline on the lede rather than the start of a step.

   Flex rather than block so nothing collapses its margin through the
   container: the loading placeholder and the real thing then begin at exactly
   the same y, which is the whole point of a shape-matched skeleton — and why
   these three are exported to `NewAppSkeleton` rather than restated there. */
export const WIZARD = 'mt-[1.6rem] flex flex-col'
/** No margin of its own — see above. `min-width: 0` because the board grid
    inside is wider than its content and a flex item floors at min-content. */
export const WIZARD_STEP = 'min-w-0'
export const FIRST_STEP_HEAD = cn(SECTION_HEAD, 'mt-0 border-t-0 pt-0')

const WARN_BANNER = 'mb-[1.35rem] text-foreground'
const MUTED_BANNER = 'mb-[1.35rem] text-(--text-muted)'

function NewAppPage() {
  const site = useSite()
  const { options } = Route.useLoaderData()

  return (
    <>
      <Crumbs>
        <Link to="/apps" className="hover:text-foreground">
          Apps
        </Link>{' '}
        <span aria-hidden="true">›</span> new
      </Crumbs>
      <PageHead title="Add an app">
        One repository under <code>github.com/{site.owner}</code> — one the box’s GitHub App is
        installed on — becomes one entry in the registry. The container, hostname, TLS, DNS, probe,
        builds and deploy timer are all derived from it.
      </PageHead>

      <GuardedAwait resetKey="options" promise={options} fallback={<NewAppSkeleton />}>
        {(data) => <Wizard options={data} />}
      </GuardedAwait>
    </>
  )
}

function Wizard({ options }: { options: Options }) {
  const site = useSite()
  const router = useRouter()

  const [repo, setRepo] = useState<Repo | null>(null)
  const [search, setSearch] = useState('')

  const [description, setDescription] = useState('')
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

  // The manual re-run trigger for the check below.
  const [recheck, setRecheck] = useState(0)

  // The app key IS the repo name. Not a free field: the default image is
  // `registry.toscanini.me/<name>:latest` and the build queue keys an app's
  // builds off the same name, so a name that differs from the repo silently
  // points both at something that does not exist. A fork with a different name
  // is what the image override is for.
  const name = repo?.name ?? ''

  const nameErr = repo ? appNameError(name, options.taken) : null
  const hostErr = hostnameError(site, hostname)

  // Re-check whenever the thing being checked changes. The result is about a
  // (name, image) pair, so keeping a stale one on screen after the image
  // override is edited would be worse than showing none.
  // biome-ignore lint/correctness/useExhaustiveDependencies: `recheck` is not read in the body — it is the manual re-run trigger.
  useEffect(() => {
    if (!repo) {
      setPreflight(null)
      return
    }
    let live = true
    setChecking(true)
    // Debounced: `name` and `image` are keystroke-hot dependencies, and every
    // run costs a server round trip plus a zot manifest read that is
    // deliberately uncached (the answer must flip the moment a build lands an
    // image). A third of a second of quiet separates typing from asking.
    const t = setTimeout(() => {
      void fetchAppPreflight({ data: { name, image: image.trim() || null } })
        .then((p) => {
          if (live) setPreflight(p)
        })
        .finally(() => {
          if (live) setChecking(false)
        })
    }, 350)
    return () => {
      live = false
      clearTimeout(t)
    }
  }, [repo, name, image, recheck])

  // Re-runs the same effect the debounce owns, rather than a second path
  // alongside it — so a refresh cannot race the run a keystroke already
  // scheduled, and every one of them still lands through the single `live`
  // guard.
  const recheckNow = () => {
    setRecheck((n) => n + 1)
  }

  // The one answer, as a plan: what is worth knowing before creating this.
  const plan =
    preflight === null
      ? null
      : readiness({
          imageState: preflight.imageState,
          effectiveImage: preflight.effectiveImage,
          repoBuild: preflight.repoBuild,
        })

  // No readiness term: the entry is a database row, and the app it declares
  // starts nothing until it is promoted. What is still checked is what would
  // corrupt the registry — a name or a hostname that is not free or not legal.
  const canCreate = repo !== null && nameErr === null && hostErr === null && !busy && !checking

  const create = () => {
    if (!repo) return
    setBusy(true)
    setError(null)
    void createAppFn({
      data: {
        app: {
          name,
          description: description.trim(),
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
        // Straight to the app's own page: the entry exists in the database as
        // `declared`, and that page is where the Apply that makes it real
        // lives — and, after the first build, the promotion off `declared`.
        void router.navigate({ to: '/apps/$name', params: { name }, search: { tab: 'settings' } })
      })
      .catch((e: unknown) => {
        setError(errorText(e))
        setBusy(false)
      })
  }

  return (
    <div className={WIZARD}>
      <section className={WIZARD_STEP}>
        <h2 className={FIRST_STEP_HEAD}>
          1. Repository
          <small className={SECTION_HEAD_SMALL}>
            the app key and the image name both come from it
          </small>
        </h2>

        {options.error !== null && (
          <Alert variant="warning" className={WARN_BANNER}>
            <AlertDescription>
              {options.error} Nothing is listed below — this is the whole list being missing, not a
              short one. Try again once GitHub answers; the App’s installation is on{' '}
              <Link to="/settings" search={{ tab: 'integrations' }}>
                Settings › Integrations
              </Link>
              .
            </AlertDescription>
          </Alert>
        )}
        {options.error === null && options.source === 'token' && (
          <Alert className={MUTED_BANNER}>
            <AlertDescription>
              Listing the <b>account’s</b> repositories, not the App’s: a{' '}
              <code>GITHUB_REPO_TOKEN</code> in <code>stacks/daedalus/service-keys.sops</code> is
              overriding the installation. An app can only be built from a repo the App is installed
              on.
            </AlertDescription>
          </Alert>
        )}

        <RepoPicker
          repos={options.repos}
          taken={options.taken}
          picked={repo}
          search={search}
          hostname={hostname}
          image={image}
          postgres={postgres}
          onSearch={setSearch}
          onPick={(r) => {
            setRepo(r)
            // Seed the description from the repo's own, which is usually the
            // sentence somebody already wrote for it.
            if (description === '') setDescription(r.description ?? '')
          }}
          onClear={() => {
            setRepo(null)
          }}
        />
      </section>

      {repo && (
        <>
          <section className={WIZARD_STEP}>
            <h2 className={SECTION_HEAD}>
              2. What it gets
              <small className={SECTION_HEAD_SMALL}>
                every one of these is editable afterwards
              </small>
            </h2>

            {nameErr !== null && (
              <Alert variant="warning" className={WARN_BANNER}>
                <AlertDescription>{nameErr}</AlertDescription>
              </Alert>
            )}

            <BoardGrid>
              <Board title="Identity" icon="✦" span={4}>
                <WizardField
                  label="Name"
                  value={name}
                  disabled
                  hint={
                    <>
                      The repository name, verbatim. It becomes <code>app-{name}</code>,{' '}
                      <code>
                        {name}.{site.baseDomain}
                      </code>
                      , the postgres role, and the repo its builds come from.
                    </>
                  }
                  onChange={() => undefined}
                />
                <WizardField
                  label="Description"
                  value={description}
                  placeholder="what it is, in one line"
                  hint="Shown in the app list, on its page, and on the Pocket ID consent screen if it is ever gated."
                  onChange={setDescription}
                />
                {/* No icon field: the app publishes its own and daedalus
                    reads it from there (host/app-icon.ts). Until the first
                    image is built there is nothing serving one, and the list
                    shows a monogram in the meantime. */}
              </Board>

              <Board title="Platform" icon="◱" span={4}>
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
                  hint="Only once the app actually serves /metrics. Otherwise it is a permanently-down target."
                />
                <p className={BOARD_FOOT}>
                  Not here, on purpose. <b>SSO</b> is a second, deliberate step on the app’s own
                  page: its client secret is generated on the box, so there is nothing to author
                  first. <b>Operator secrets</b> have no switch at all. Commit a{' '}
                  <code>{name || '<name>'}-env.sops</code> to <code>stacks/apps/</code> and the next
                  rebuild loads it. <b>VPN egress</b> is the one thing that still needs the flake.
                  It wants a gluetun instance to exist before anything can join its netns.
                </p>
              </Board>

              <Board title="Address" icon="↗" span={4}>
                {/* No exposure picker here, on purpose. A new app is created
                    `declared`: the row, its database, its data dir and its
                    AUTH_SECRET, and nothing running. It is the only stage that
                    can be applied before an image exists — anything higher
                    declares a container that cannot pull, which fails the
                    switch and reverts the Apply. The choice is not lost, it is
                    moved to where it can be made safely: one click on the app's
                    page once its first build has published an image. */}
                <p className={BOARD_FOOT}>
                  Created <b>declared</b>: the registry row, the database, the data directory and
                  the generated secrets — and nothing running. Promote it to internal or external on
                  its own page once its first build has published an image. The hostname below is
                  the one it will answer on then.
                </p>
                <WizardField
                  label="Hostname"
                  value={hostname}
                  placeholder={`${name}.${site.baseDomain}`}
                  validate={(v) => hostnameError(site, v)}
                  hint={
                    <>
                      Empty uses the default. One level under <code>{site.baseDomain}</code>, since
                      the wildcard certificate matches exactly one label.
                    </>
                  }
                  onChange={setHostname}
                />
                <WizardField
                  label="Image override"
                  value={image}
                  placeholder={defaultImage(site, name)}
                  hint="Empty uses the box's own registry, which is where its builds publish to. Set this for a fork, another registry, or a pinned digest."
                  onChange={setImage}
                />
              </Board>
            </BoardGrid>
          </section>

          <section className={WIZARD_STEP}>
            {plan === null ? (
              <>
                <h2 className={SECTION_HEAD}>
                  3. Readiness
                  <small className={SECTION_HEAD_SMALL}>is there an image this box can pull?</small>
                </h2>
                <Alert className={MUTED_BANNER}>
                  <AlertDescription>Checking the registry…</AlertDescription>
                </Alert>
              </>
            ) : (
              <ReadinessPanel plan={plan} refreshing={checking} onRefresh={recheckNow} />
            )}

            {error !== null && (
              <Alert variant="warning" className={WARN_BANNER}>
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-4">
              <Button type="button" size="sm" disabled={!canCreate} onClick={create}>
                {busy ? 'Creating…' : 'Create entry'}
              </Button>
              <p className="m-0 max-w-[46rem] text-[0.8rem] text-(--dim)">
                Writes the registry row, declared. The next Apply commits site/apps.json and
                rebuilds — which creates its database, its data directory and its secrets, and
                starts nothing. Being in that file is what lets the box build the repo at all.
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  )
}

/**
 * A plain controlled field.
 *
 * Not the TextField from the app detail page: that one saves on blur because
 * it edits a record that already exists, and every keystroke here belongs to a
 * form that has not been submitted yet.
 */
function WizardField({
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
  const id = useId()
  const error = validate ? validate(value) : null
  return (
    // `has-[:disabled]:opacity-100`: the Name row is disabled by design — the
    // repo decides it — and dimming its label would say "locked" about the one
    // field the reader most needs to read. The input dims itself.
    <Field className="gap-[0.3rem] py-2 has-[:disabled]:opacity-100">
      <FieldLabel htmlFor={id} className="text-[0.76rem] font-normal text-(--dim)">
        {label}
      </FieldLabel>
      <Input
        id={id}
        type="text"
        className="h-auto rounded-[8px] bg-(--panel-2) px-[0.65rem] py-[0.45rem] md:text-[0.87rem] dark:bg-(--panel-2)"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== null}
        onChange={(e) => {
          onChange(e.target.value)
        }}
      />
      {error !== null ? (
        <FieldError className="text-[0.76rem] leading-[1.45]">{error}</FieldError>
      ) : (
        hint !== undefined && (
          <FieldDescription className="text-[0.76rem] leading-[1.45]">{hint}</FieldDescription>
        )
      )}
    </Field>
  )
}
