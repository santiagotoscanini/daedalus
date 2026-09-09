import { Await, createFileRoute, useRouter } from '@tanstack/react-router'
import { useState, useTransition } from 'react'

import { PageHead } from '../components/page'
import { Appearance } from '../components/settings/appearance'
import { Developer } from '../components/settings/developer'
import { General } from '../components/settings/general'
import { Integrations } from '../components/settings/integrations'
import { Network } from '../components/settings/network'
import { Repository } from '../components/settings/repository'
import { TabBar } from '../components/tabs'
import { fetchBoxSettings, fetchIntegrationStatus, fetchTheme } from '../server/settings'
import { fetchSiteState } from '../server/site'

// Settings — what this box IS, as opposed to what it runs.
//
// Read-only, apart from Appearance. Each section shows what already reaches
// the container — env bound by daedalus.nix, the /export domains, the host
// snapshots — and says where it read it from. Nothing here is guessed, and
// nothing here is editable until the site repository exists to edit it in.
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
  // on. The integration checks are not — they ask Cloudflare and GitHub, so
  // they stream in behind the page, and only for the tab that shows them.
  loader: async ({ deps }) => {
    const [theme, settings] = await Promise.all([fetchTheme(), fetchBoxSettings()])
    return {
      theme,
      settings,
      integrations: deps.tab === 'integrations' ? fetchIntegrationStatus() : null,
      // Deferred for the same reason: it renders site.json to hash it, for the
      // one tab that shows the answer.
      site: deps.tab === 'repository' ? fetchSiteState() : null,
    }
  },
  component: SettingsPage,
})

function SettingsPage() {
  const { theme, settings, integrations, site } = Route.useLoaderData()
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

      <div className="mt-6 max-w-4xl pb-16">
        {tab === 'general' && <General settings={settings} />}
        {tab === 'network' && <Network settings={settings} />}
        {tab === 'integrations' &&
          (integrations === null ? (
            <Integrations settings={settings.integrations} status={null} />
          ) : (
            <Await
              promise={integrations}
              fallback={<Integrations settings={settings.integrations} status={null} />}
            >
              {(status) => <Integrations settings={settings.integrations} status={status} />}
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
    </>
  )
}
