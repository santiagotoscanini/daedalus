// The create form, step by step. The route (routes/apps.new.tsx) says what
// creating an app means and what this form will not do.

import { Link, useRouter } from '@tanstack/react-router'
import { useEffect, useState } from 'react'
import type { Repo } from '../../host/github-repos'
import { cn } from '../../lib/cn'
import { appNameError, hostnameError } from '../../lib/hostname'
import { readiness } from '../../lib/readiness'
import { defaultImage } from '../../lib/site'
import { useSite } from '../../lib/site-context'
import { NEW_APP_STAGES, type NewAppStage, STAGE_LABEL } from '../../lib/stage'
import { createAppFn, fetchAppPreflight, type fetchNewAppOptions } from '../../server/registry'
import { Segmented } from '../controls'
import { Toggle } from '../slider'
import { FOOT } from '../tokens'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { useAction } from '../use-action'
import { Board, BoardGrid } from '../viz'
import { ReadinessPanel } from './readiness'
import { RepoPicker } from './repo-picker'
import { SECTION_HEAD, SECTION_HEAD_SMALL } from './shared'
import { WizardField } from './wizard-field'

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
const MUTED_BANNER = 'mb-[1.35rem] text-subdued'

export function Wizard({ options }: { options: Options }) {
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
  const [stage, setStage] = useState<NewAppStage>('lab')

  const [preflight, setPreflight] = useState<Preflight | null>(null)
  const [checking, setChecking] = useState(false)
  const { run, busy, error } = useAction()
  // Created, but not linked to its repository (lib/apps/create.ts createAppLinked).
  const [unlinked, setUnlinked] = useState<{ name: string; reason: string } | null>(null)

  // The manual re-run trigger for the check below.
  const [recheck, setRecheck] = useState(0)

  // The app key IS the repo name. Not a free field: the default image is
  // `<registryHost>/<name>:latest` and the build queue keys an app's
  // builds off the same name, so a name that differs from the repo silently
  // points both at something that does not exist. A fork with a different name
  // is what the image override is for.
  const name = repo?.name ?? ''

  const nameErr = repo ? appNameError(name, options.taken, options.reservedLabels) : null
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
  const canCreate =
    repo !== null && nameErr === null && hostErr === null && !busy && !checking && unlinked === null

  const create = () => {
    if (!repo) return
    run(
      () =>
        createAppFn({
          data: {
            app: {
              name,
              stage,
              description: description.trim(),
              postgres,
              storage,
              litellm,
              prometheus,
              image: image.trim() || null,
              hostname: hostname.trim() || null,
            },
          },
        }),
      {
        invalidate: false,
        // Straight to the app's own page, where its way to its first
        // container is one line (lib/apps/setup.ts). Unless the repository
        // could not be linked: that is said here, once, before leaving.
        onDone: (r) =>
          r.link.ok
            ? router.navigate({ to: '/apps/$name', params: { name }, search: { tab: 'overview' } })
            : setUnlinked({ name: r.name, reason: r.link.reason }),
      },
    )
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
                <p className={FOOT}>
                  Not here, on purpose. <b>Sign-in</b> starts as the app’s own OIDC client, probed
                  at <code>/api/healthz</code>, as an app made from the iris template expects; its
                  page changes either. <b>Operator secrets</b> have no switch at all. Once the app
                  is set up, set them on its Secrets tab, which writes{' '}
                  <code>site/vault/apps/{name || '<name>'}-env.sops</code>; the next rebuild loads
                  it. <b>VPN egress</b> is the one thing that still needs the flake. It wants a
                  gluetun instance to exist before anything can join its netns.
                </p>
              </Board>

              <Board title="Address" icon="↗" span={4}>
                <Segmented
                  value={stage}
                  onChange={setStage}
                  label="Where it runs"
                  options={NEW_APP_STAGES.map((s) => ({ value: s, label: STAGE_LABEL[s] }))}
                />
                <p className={FOOT}>
                  <b>Lab</b> answers on the LAN only; <b>Public</b> is also published through the
                  tunnel. Nothing of the app exists until its first build has published an image;
                  then one Apply creates it here.
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
            {unlinked !== null && (
              <Alert variant="warning" className={WARN_BANNER}>
                <AlertDescription>
                  Created {unlinked.name}, but it is not linked to a GitHub repository, so it cannot
                  build yet. {unlinked.reason} Build now on{' '}
                  <Link
                    to="/apps/$name"
                    params={{ name: unlinked.name }}
                    search={{ tab: 'deployments' }}
                  >
                    its page
                  </Link>{' '}
                  tries again.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex flex-wrap items-center gap-4">
              <Button type="button" size="sm" disabled={!canCreate} onClick={create}>
                {busy ? 'Creating…' : 'Create app'}
              </Button>
              <p className="m-0 max-w-[46rem] text-[0.8rem] text-muted-foreground">
                Commits its entry to site/apps.json without a rebuild and queues its first build.
                Once that build has published, one Apply creates its database, secrets, sign-in,
                container, route and probe, and starts it.
              </p>
            </div>
          </section>
        </>
      )}
    </div>
  )
}
