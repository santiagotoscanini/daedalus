import { createFileRoute, useRouter } from '@tanstack/react-router'
import {
  CodeIcon,
  FolderGit2Icon,
  NetworkIcon,
  PaletteIcon,
  PlugIcon,
  SlidersHorizontalIcon,
  UserIcon,
} from 'lucide-react'
import { type ReactNode, useEffect, useRef, useState, useTransition } from 'react'

import { ApplyBar } from '../components/apply-bar'
import { GuardedAwait } from '../components/error'
import { PageHead } from '../components/page'
import { usePoll } from '../components/poll'
import { Appearance } from '../components/settings/appearance'
import { Developer } from '../components/settings/developer'
import { General } from '../components/settings/general'
import { Integrations } from '../components/settings/integrations'
import { Network } from '../components/settings/network'
import { ProfileTab } from '../components/settings/profile'
import { Repository } from '../components/settings/repository'
import { SiteDiff } from '../components/settings/site-fields'
import { TabBar } from '../components/tabs'
import type { GithubAppStatus, GithubCallbackNotice } from '../core/settings/types'
import { fetchProfile } from '../server/profile'
import { fetchApplyStatus } from '../server/registry'
import {
  fetchBoxSettings,
  fetchGeneralLive,
  fetchGithubAppStatus,
  fetchIntegrationStatus,
  fetchTheme,
  fetchTimezones,
  githubInstallLandedFn,
} from '../server/settings'
import { fetchSiteEdit, fetchSiteState } from '../server/site'

// Settings — what this box IS, as opposed to what it runs.
//
// Each section shows what reaches the container — env bound by daedalus.nix,
// the /export domains, the host snapshots — and says where it read it from.
// Nothing here is guessed. The rows nix sources from site/site.json are
// editable (core/site EDITABLE — the domain, the addresses, DHCP, the DNS
// upstreams, the two mail addresses, the timezone); an edit is a stored draft against the
// committed file, shown as `pending` beside the row, and the Apply bar at the
// foot is what writes the file and rebuilds. Everything else is read-only.
//
// The dividing line every section on this page has to respect: a setting the
// NixOS side consumes belongs in the site repository, where changing it is a
// commit and a rebuild. A setting it does not — the theme, and every UI
// preference after it — belongs in Postgres, where changing it is an UPDATE
// and nothing rebuilds. Appearance is deliberately the second kind, which is
// why it can save on click with no Apply bar. Profile is a third kind: it is
// state inside Pocket ID, written through Pocket ID's API, and also saves at
// once.

/** A tab's label with its icon: drawn quieter than the word, which carries the meaning. */
function TabLabel({ icon, children }: { icon: ReactNode; children: ReactNode }) {
  return (
    <>
      <span aria-hidden="true" className="inline-flex opacity-70 [&>svg]:size-[15px]">
        {icon}
      </span>
      {children}
    </>
  )
}

const TABS = [
  { id: 'general', label: <TabLabel icon={<SlidersHorizontalIcon />}>General</TabLabel> },
  { id: 'network', label: <TabLabel icon={<NetworkIcon />}>Network</TabLabel> },
  { id: 'integrations', label: <TabLabel icon={<PlugIcon />}>Integrations</TabLabel> },
  { id: 'repository', label: <TabLabel icon={<FolderGit2Icon />}>Site</TabLabel> },
  { id: 'profile', label: <TabLabel icon={<UserIcon />}>Profile</TabLabel> },
  { id: 'appearance', label: <TabLabel icon={<PaletteIcon />}>Appearance</TabLabel> },
  { id: 'developer', label: <TabLabel icon={<CodeIcon />}>Developer</TabLabel> },
] as const

type SettingsTab = (typeof TABS)[number]['id']

function isTab(v: string | undefined): v is SettingsTab {
  return TABS.some((t) => t.id === v)
}

/** How long the GitHub App section keeps asking after an install, and how often. */
const INSTALL_WATCH_MS = 60_000
const INSTALL_POLL_MS = 5_000

export const Route = createFileRoute('/settings')({
  // The sub-tab is in the URL for the same reason the category pages put it
  // there: it survives a refresh, it can be linked, and it renders on the
  // server.
  validateSearch: (
    search: Record<string, unknown>,
  ): {
    tab?: string
    github?: Exclude<GithubCallbackNotice['github'], 'installed'>
    reason?: string
    setup_action?: 'install' | 'update'
  } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    // What /settings/github/callback redirected with. Read once, then dropped.
    github:
      search.github === 'created' || search.github === 'pending' || search.github === 'failed'
        ? search.github
        : undefined,
    // A code, never text: anything not shaped like one is dropped here, and
    // the tab maps the rest to its own sentences.
    reason:
      typeof search.reason === 'string' && /^[a-z-]{1,40}$/.test(search.reason)
        ? search.reason
        : undefined,
    // GitHub's setup URL after an install: `?installation_id=…&setup_action=`.
    // Only the action is read. The id is not — a link can carry any id — and
    // the host's minter finds the installation by itself.
    setup_action:
      search.setup_action === 'install' || search.setup_action === 'update'
        ? search.setup_action
        : undefined,
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  // The facts are awaited: files and one database row, no upstream to wait
  // on. So is the site edit (two file reads and a row) and the apply status,
  // because the Apply bar is on every tab. The integration checks are not —
  // they ask Cloudflare and GitHub, so they stream in behind the page, and
  // only for the tab that shows them.
  loader: async ({ deps }) => {
    const general = !isTab(deps.tab) || deps.tab === 'general'
    const [theme, settings, edit, applyStatus, timezones, githubApp] = await Promise.all([
      fetchTheme(),
      fetchBoxSettings(),
      fetchSiteEdit(),
      fetchApplyStatus(),
      // A file read, so awaited like the facts; only General has the picker.
      general ? fetchTimezones() : Promise.resolve<string[]>([]),
      // Two file reads and a row, no upstream: awaited, for the tab that shows it.
      deps.tab === 'integrations' ? fetchGithubAppStatus() : Promise.resolve(null),
    ])
    return {
      theme,
      settings,
      edit,
      applyStatus,
      timezones,
      githubApp,
      // The zone list and the NixOS release ask Cloudflare, endoflife.date and
      // GitHub, so they stream in behind the tab like the integration checks.
      live: general ? fetchGeneralLive() : null,
      integrations: deps.tab === 'integrations' ? fetchIntegrationStatus() : null,
      // Asks Pocket ID, so it streams in the same way.
      profile: deps.tab === 'profile' ? fetchProfile() : null,
      // Deferred for the same reason: it renders site.json to hash it, for the
      // one tab that shows the answer.
      site: deps.tab === 'repository' ? fetchSiteState() : null,
    }
  },
  component: SettingsPage,
})

function SettingsPage() {
  const {
    theme,
    settings,
    integrations,
    profile,
    site,
    edit,
    applyStatus,
    timezones,
    live,
    githubApp,
  } = Route.useLoaderData()
  // The bar's vocabulary is the registry's — a list of named things and the
  // fields that changed — so the site document is one entry named `site`.
  const changed = edit.changes.length > 0 ? [{ name: 'site', fields: [...edit.changes] }] : []
  const search = Route.useSearch()
  const tab: SettingsTab = isTab(search.tab) ? search.tab : 'general'

  const router = useRouter()
  const [pending, startTransition] = useTransition()

  // The GitHub callback's verdict, or GitHub's install redirect, arrives in
  // the query once. It is held here, above the Await that remounts the tab
  // when the live checks land, and the query is dropped so a reload does not
  // repeat it.
  const landed = search.setup_action !== undefined
  const [githubNotice, setGithubNotice] = useState<GithubCallbackNotice | null>(() =>
    search.github !== undefined
      ? { github: search.github, code: search.reason ?? null }
      : landed
        ? { github: 'installed', code: null }
        : null,
  )
  useEffect(() => {
    if (search.github === undefined && search.reason === undefined && !landed) return
    void router.navigate({
      to: '/settings',
      search: { tab: landed ? 'integrations' : search.tab },
      replace: true,
    })
  }, [search.github, search.reason, search.tab, landed, router])

  // After an install the host's minter has not looked yet, so the App reads
  // "not installed". Ask it to look now, then re-read the App's status every
  // few seconds for a minute, so "installed" arrives without a reload.
  const [watchUntil, setWatchUntil] = useState<number | null>(null)
  // Tagged with the loader read it was polled over: a fresh loader read is
  // newer than anything the poll held, so a stale tag falls back to it.
  const [polled, setPolled] = useState<{
    over: typeof githubApp
    status: GithubAppStatus
  } | null>(null)
  const askedMinter = useRef(false)
  useEffect(() => {
    if (!landed || askedMinter.current) return
    askedMinter.current = true
    void githubInstallLandedFn()
      .then((r) => {
        if (r.ok) setWatchUntil(Date.now() + INSTALL_WATCH_MS)
      })
      .catch(() => {})
  }, [landed])
  const loaderApp = useRef(githubApp)
  loaderApp.current = githubApp
  usePoll(
    async () => {
      // Re-read rather than closed over: `usePoll` calls the newest closure,
      // so this is the current deadline and not the one the watch started with.
      if (watchUntil === null) return
      try {
        const s = await fetchGithubAppStatus()
        setPolled({ over: loaderApp.current, status: s })
        if (s.state === 'installed' || Date.now() >= watchUntil) setWatchUntil(null)
      } catch {
        if (Date.now() >= watchUntil) setWatchUntil(null)
      }
    },
    INSTALL_POLL_MS,
    watchUntil !== null,
  )

  const github = {
    app: polled !== null && polled.over === githubApp ? polled.status : githubApp,
    notice: githubNotice,
    onDismissNotice: () => {
      setGithubNotice(null)
    },
  }
  // The choice is held here as well as in the loader so a click repaints the
  // page immediately. The save is what makes it durable; the router
  // invalidation below is what makes the SERVER agree, which matters because
  // the palette is server-rendered into the document head.
  const [choice, setChoice] = useState(theme)

  return (
    <>
      <PageHead title="Settings">
        How this box is configured, and how it looks. What nix builds from is edited here and
        applied as a rebuild; Profile saves to your Pocket ID account and Appearance to this control
        plane, both at once.
      </PageHead>

      <TabBar
        tabs={TABS}
        active={tab}
        linkTo={(id) => ({ to: '/settings', search: { tab: id } })}
      />

      <div className="mt-6 flex max-w-4xl flex-col gap-6 pb-24">
        {/* One place for the bytes an Apply would write, whichever tab the
            edit was made on — the tabs show fields, this shows the file. */}
        <SiteDiff edit={edit} />

        {tab === 'general' &&
          (live === null ? (
            <General settings={settings} edit={edit} timezones={timezones} live={null} />
          ) : (
            <GuardedAwait
              resetKey={tab}
              promise={live}
              fallback={
                <General settings={settings} edit={edit} timezones={timezones} live={null} />
              }
            >
              {(l) => <General settings={settings} edit={edit} timezones={timezones} live={l} />}
            </GuardedAwait>
          ))}
        {tab === 'network' && <Network settings={settings} edit={edit} />}
        {tab === 'integrations' &&
          (integrations === null ? (
            <Integrations
              settings={settings.integrations}
              status={null}
              edit={edit}
              github={github}
            />
          ) : (
            <GuardedAwait
              resetKey={tab}
              promise={integrations}
              fallback={
                <Integrations
                  settings={settings.integrations}
                  status={null}
                  edit={edit}
                  github={github}
                />
              }
            >
              {(status) => (
                <Integrations
                  settings={settings.integrations}
                  status={status}
                  edit={edit}
                  github={github}
                />
              )}
            </GuardedAwait>
          ))}
        {tab === 'repository' &&
          (site === null ? (
            <Repository settings={settings} site={null} />
          ) : (
            <GuardedAwait
              resetKey={tab}
              promise={site}
              fallback={<Repository settings={settings} site={null} />}
            >
              {(state) => <Repository settings={settings} site={state} />}
            </GuardedAwait>
          ))}
        {tab === 'profile' &&
          (profile === null ? (
            <ProfileTab operator={settings.general.operator} profile={null} />
          ) : (
            <GuardedAwait
              resetKey={tab}
              promise={profile}
              fallback={<ProfileTab operator={settings.general.operator} profile={null} />}
            >
              {(p) => <ProfileTab operator={settings.general.operator} profile={p} />}
            </GuardedAwait>
          ))}
        {tab === 'appearance' && (
          <Appearance
            value={choice}
            saving={pending}
            onChange={(next) => {
              setChoice(next)
              startTransition(async () => {
                const { saveTheme } = await import('../server/settings')
                await saveTheme({ data: next })
                await router.invalidate()
              })
            }}
          />
        )}
        {tab === 'developer' && <Developer settings={settings} />}
      </div>

      <ApplyBar changed={changed} initialStatus={applyStatus} />
    </>
  )
}
