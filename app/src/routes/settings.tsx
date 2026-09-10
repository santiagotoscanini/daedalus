import { Await, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState, useTransition } from 'react'

import { ApplyBar } from '../components/apply-bar'
import { PageHead } from '../components/page'
import { Appearance } from '../components/settings/appearance'
import { Developer } from '../components/settings/developer'
import { General } from '../components/settings/general'
import { Integrations } from '../components/settings/integrations'
import { Network } from '../components/settings/network'
import { Repository } from '../components/settings/repository'
import { SiteDiff } from '../components/settings/site-fields'
import { TabBar } from '../components/tabs'
import { fetchApplyStatus } from '../server/registry'
import { fetchBoxSettings, fetchIntegrationStatus, fetchTheme } from '../server/settings'
import { fetchSiteEdit, fetchSiteState } from '../server/site'

// Settings — what this box IS, as opposed to what it runs.
//
// Each section shows what reaches the container — env bound by daedalus.nix,
// the /export domains, the host snapshots — and says where it read it from.
// Nothing here is guessed. The rows nix sources from site/site.json are
// editable (core/site EDITABLE — the domain, the addresses, DHCP, the DNS
// upstreams, the two mail addresses); an edit is a stored draft against the
// committed file, shown as `pending` beside the row, and the Apply bar at the
// foot is what writes the file and rebuilds. Everything else is read-only.
//
// The dividing line every section on this page has to respect: a setting the
// NixOS side consumes belongs in the site repository, where changing it is a
// commit and a rebuild. A setting it does not — the theme, and every UI
// preference after it — belongs in Postgres, where changing it is an UPDATE
// and nothing rebuilds. Appearance is deliberately the second kind, which is
// why it can save on click with no Apply bar.

const TABS = [
  { id: 'general', label: 'General' },
  { id: 'network', label: 'Network' },
  { id: 'integrations', label: 'Integrations' },
  { id: 'repository', label: 'Site' },
  { id: 'appearance', label: 'Appearance' },
  { id: 'developer', label: 'Developer' },
] as const

type SettingsTab = (typeof TABS)[number]['id']

function isTab(v: string | undefined): v is SettingsTab {
  return TABS.some((t) => t.id === v)
}

export const Route = createFileRoute('/settings')({
  // The sub-tab is in the URL for the same reason the category pages put it
  // there: it survives a refresh, it can be linked, and it renders on the
  // server.
  validateSearch: (search: Record<string, unknown>): { tab?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab }),
  // The facts are awaited: files and one database row, no upstream to wait
  // on. So is the site edit (two file reads and a row) and the apply status,
  // because the Apply bar is on every tab. The integration checks are not —
  // they ask Cloudflare and GitHub, so they stream in behind the page, and
  // only for the tab that shows them.
  loader: async ({ deps }) => {
    const [theme, settings, edit, applyStatus] = await Promise.all([
      fetchTheme(),
      fetchBoxSettings(),
      fetchSiteEdit(),
      fetchApplyStatus(),
    ])
    return {
      theme,
      settings,
      edit,
      applyStatus,
      integrations: deps.tab === 'integrations' ? fetchIntegrationStatus() : null,
      // Deferred for the same reason: it renders site.json to hash it, for the
      // one tab that shows the answer.
      site: deps.tab === 'repository' ? fetchSiteState() : null,
    }
  },
  component: SettingsPage,
})

function SettingsPage() {
  const { theme, settings, integrations, site, edit, applyStatus } = Route.useLoaderData()
  // The bar's vocabulary is the registry's — a list of named things and the
  // fields that changed — so the site document is one entry named `site`.
  const changed = edit.changes.length > 0 ? [{ name: 'site', fields: [...edit.changes] }] : []
  const search = Route.useSearch()
  const tab: SettingsTab = isTab(search.tab) ? search.tab : 'general'

  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // The choice is held here as well as in the loader so a click repaints the
  // page immediately. The save is what makes it durable; the router
  // invalidation below is what makes the SERVER agree, which matters because
  // the palette is server-rendered into the document head.
  const [choice, setChoice] = useState(theme)

  return (
    <>
      <PageHead title="Settings">
        How this box is configured, and how it looks. Everything but Appearance is read from what
        the system declares; Appearance is stored for this control plane alone.
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

        {tab === 'general' && <General settings={settings} edit={edit} />}
        {tab === 'network' && <Network settings={settings} edit={edit} />}
        {tab === 'integrations' &&
          (integrations === null ? (
            <Integrations settings={settings.integrations} status={null} edit={edit} />
          ) : (
            <Await
              promise={integrations}
              fallback={<Integrations settings={settings.integrations} status={null} edit={edit} />}
            >
              {(status) => (
                <Integrations settings={settings.integrations} status={status} edit={edit} />
              )}
            </Await>
          ))}
        {tab === 'repository' &&
          (site === null ? (
            <Repository settings={settings} site={null} />
          ) : (
            <Await promise={site} fallback={<Repository settings={settings} site={null} />}>
              {(state) => <Repository settings={settings} site={state} />}
            </Await>
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
