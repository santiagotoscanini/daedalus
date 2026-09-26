import { createFileRoute } from '@tanstack/react-router'
import {
  CodeIcon,
  FolderGit2Icon,
  GlobeIcon,
  LayersIcon,
  MonitorSmartphoneIcon,
  NetworkIcon,
  PaletteIcon,
  PlugIcon,
  SlidersHorizontalIcon,
} from 'lucide-react'
import type { ReactNode } from 'react'

import { ApplyBar } from '../components/apply-bar'
import { Measure, PageHead } from '../components/page'
import { SiteDiff } from '../components/settings/site-fields'
import { SettingsTabBody } from '../components/settings/tab-body'
import { useGithubLanding } from '../components/settings/use-github-landing'
import { TabBar } from '../components/tabs'
import type { GithubCallbackNotice } from '../core/settings/types'
import { known } from '../lib/known'
import { siteBarFields } from '../lib/module-switch'
import { fetchModuleSwitches } from '../server/modules'
import { fetchMachinesFn } from '../server/nodes'
import { fetchApplyStatus } from '../server/registry'
import {
  fetchAuthorization,
  fetchBoxSettings,
  fetchExternalApps,
  fetchGithubAppStatus,
  fetchIntegrationStatus,
  fetchMcpTokens,
  fetchTheme,
  fetchTimezones,
  fetchZones,
} from '../server/settings'
import { fetchSiteEdit, fetchSiteState } from '../server/site'

// Settings — what this box IS, as opposed to what it runs.
//
// Each section shows what reaches the container — env bound by daedalus.nix,
// the /export domains, the host snapshots — and says where it read it from.
// Nothing here is guessed. The site/site.json fields core/site/index.ts's
// EDITABLE list names are editable — what nix builds from, plus a few the
// host agents read at Apply time; an edit is a stored draft
// against the committed file, shown as `pending` beside the row, and the
// Apply bar at the foot is what writes the file and rebuilds. Everything else
// is read-only.
//
// The dividing line every section on this page has to respect: a setting the
// NixOS side consumes belongs in the site repository, where changing it is a
// commit and a rebuild. A setting it does not — the theme, the off-box
// projects, what the box asks of the other machines, and every UI
// preference after them — belongs in Postgres, where changing it is an
// UPDATE and nothing rebuilds. Appearance and Projects are deliberately the
// second kind, which is why they save on click with no Apply bar. Machines
// saves on click too, but a machine's id, name, OS and providers also reach
// nix as site/nodes.json at the next Apply (host/apply-flow.ts
// nodesChange). Machines is also where the other machines are SHOWN — what
// each one is, whether it answers, whether the box trusts it — because the
// decision about a machine and the policy sent to it are one story, and
// splitting it across a dashboard tab and a settings tab meant reading both.
//
// Two things that look like settings are not on this page, on purpose. The
// person — the Pocket ID account — is /profile, reached from the account
// menu: everything here is about the machine, and a person filed among its
// network and integrations read as one more property of it. And what the
// box RUNS — the NixOS release, its support window, the channel — is on
// System › Updates beside the engine's pin, with the other things that move.
//
// The tabs are the nine subjects a box has, in the order a first visit
// reads them: what it is called, how it is reached, what it talks to, where
// its configuration lives, what else it lists, which other machines it
// trusts and what it asks of them, which catalog modules it runs, how it
// looks, and how it is driven.

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
  { id: 'projects', label: <TabLabel icon={<GlobeIcon />}>Projects</TabLabel> },
  { id: 'machines', label: <TabLabel icon={<MonitorSmartphoneIcon />}>Machines</TabLabel> },
  { id: 'modules', label: <TabLabel icon={<LayersIcon />}>Modules</TabLabel> },
  { id: 'appearance', label: <TabLabel icon={<PaletteIcon />}>Appearance</TabLabel> },
  { id: 'developer', label: <TabLabel icon={<CodeIcon />}>Developer</TabLabel> },
] as const

type SettingsTab = (typeof TABS)[number]['id']

function isTab(v: string | undefined): v is SettingsTab {
  return TABS.some((t) => t.id === v)
}

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
  // because the Apply bar is on every tab. Awaited from this browser's
  // memory past the first visit (lib/known.ts) — the forms are drawn from
  // them, and a tab that waited on nine round trips to draw a form was the
  // slowest click in the app — and read fresh when a save invalidates.
  // The integration checks are not awaited at all: they ask Cloudflare and
  // GitHub, so they stream in behind the page, and only for the tab that
  // shows them; so does the machine list, which probes the LAN.
  loader: async ({ deps }) => {
    const general = !isTab(deps.tab) || deps.tab === 'general'
    const [
      theme,
      settings,
      edit,
      applyStatus,
      timezones,
      externalApps,
      githubApp,
      mcpTokens,
      authorization,
    ] = await Promise.all([
      known('settings/theme', fetchTheme),
      known('settings/box', fetchBoxSettings),
      known('settings/edit', fetchSiteEdit),
      known('settings/apply', fetchApplyStatus),
      // A file read; only General has the picker.
      general ? known('settings/timezones', fetchTimezones) : Promise.resolve<string[]>([]),
      // One row, and only Projects has the editor.
      deps.tab === 'projects' ? known('settings/projects', fetchExternalApps) : Promise.resolve([]),
      // Two file reads and a row, for the tab that shows it.
      deps.tab === 'integrations'
        ? known('settings/github', fetchGithubAppStatus)
        : Promise.resolve(null),
      // One indexed table read, and only for the tab that lists them.
      deps.tab === 'developer' ? known('settings/mcp', fetchMcpTokens) : Promise.resolve([]),
      // The decision for this very request: two headers and one row.
      deps.tab === 'developer'
        ? known('settings/authorization', fetchAuthorization)
        : Promise.resolve(null),
    ])
    return {
      theme,
      settings,
      edit,
      applyStatus,
      timezones,
      externalApps,
      githubApp,
      mcpTokens,
      authorization,
      // One table read plus a LAN probe of every machine, which can take
      // seconds when one is asleep: streamed, behind a skeleton the first
      // time and in place after.
      machines: deps.tab === 'machines' ? fetchMachinesFn() : null,
      // Four export reads and the site draft, for the tab that lists the switches.
      modules: deps.tab === 'modules' ? fetchModuleSwitches() : null,
      // The zone list asks Cloudflare, so it streams in behind the tab like the
      // integration checks.
      zones: general ? fetchZones() : null,
      integrations: deps.tab === 'integrations' ? fetchIntegrationStatus() : null,
      // Deferred for the same reason: it renders site.json to hash it, for the
      // one tab that shows the answer.
      site: deps.tab === 'repository' ? fetchSiteState() : null,
    }
  },
  component: SettingsPage,
})

function SettingsPage() {
  const data = Route.useLoaderData()
  const { edit, applyStatus, githubApp } = data
  // The bar's vocabulary is the registry's — a list of named things and the
  // fields that changed — so the site document is one entry named `site`.
  const changed =
    edit.changes.length > 0
      ? [{ name: 'site', fields: siteBarFields(edit.changes, edit.moduleChanges) }]
      : []
  const search = Route.useSearch()
  const tab: SettingsTab = isTab(search.tab) ? search.tab : 'general'
  // Held here, above the GuardedAwait in the tab body that remounts the tab
  // when the live checks land (components/settings/use-github-landing.ts).
  const github = useGithubLanding(search, githubApp)

  return (
    <Measure>
      <PageHead title="Settings">
        How this box is configured, and how it looks. What nix builds from is edited here and
        applied as a rebuild; Projects, Machines and Appearance save to this control plane at once.
      </PageHead>

      <TabBar
        tabs={TABS}
        active={tab}
        linkTo={(id) => ({ to: '/settings', search: { tab: id } })}
      />

      <div className="flex flex-col gap-6 pb-24">
        {/* One place for the bytes an Apply would write, whichever tab the
            edit was made on — the tabs show fields, this shows the file. */}
        <SiteDiff edit={edit} />
        <SettingsTabBody tab={tab} data={data} github={github} />
      </div>

      <ApplyBar changed={changed} initialStatus={applyStatus} />
    </Measure>
  )
}
