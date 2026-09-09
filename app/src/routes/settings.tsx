import { createFileRoute, useRouter } from '@tanstack/react-router'
import { useState, useTransition } from 'react'

import { PageHead } from '../components/page'
import { Appearance } from '../components/settings/appearance'
import { TabBar } from '../components/tabs'
import { fetchTheme } from '../server/settings'

// Settings — what this box IS, as opposed to what it runs.
//
// The page frame lands before the sections that fill it, so the tab shape is
// fixed now and each section arrives against it rather than reshaping the
// page. Appearance is the only one that is editable today; the rest of this
// page becomes the read-only view of the box's identity, network and
// integrations, and later the place those are configured from.
//
// The dividing line every section on this page has to respect: a setting the
// NixOS side consumes belongs in the site repository, where changing it is a
// commit and a rebuild. A setting it does not — the theme, and every UI
// preference after it — belongs in Postgres, where changing it is an UPDATE
// and nothing rebuilds. Appearance is deliberately the second kind, which is
// why it can save on click with no Apply bar.

const TABS = [{ id: 'appearance', label: 'Appearance' }] as const

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
  // Awaited, unlike the dashboards: this page is small, has no upstream to
  // wait on, and a skeleton for one database row would be theatre.
  loader: async () => ({ theme: await fetchTheme() }),
  component: SettingsPage,
})

function SettingsPage() {
  const { theme } = Route.useLoaderData()
  const search = Route.useSearch()
  const tab: SettingsTab = isTab(search.tab) ? search.tab : 'appearance'

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
        How this box is configured, and how it looks. Appearance is stored for this control plane
        alone — it changes nothing the system runs.
      </PageHead>

      <TabBar
        tabs={TABS}
        active={tab}
        linkTo={(id) => ({ to: '/settings', search: { tab: id } })}
      />

      <div className="mt-6 max-w-4xl pb-16">
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
      </div>
    </>
  )
}
