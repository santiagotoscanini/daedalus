import { useRouter } from '@tanstack/react-router'
import { type ReactNode, useState, useTransition } from 'react'
import type { BoxSettings, IntegrationStatus, ZoneList } from '../../core/settings/types'
import type { SiteEdit, SiteState } from '../../core/site'
import type { McpTokenRow } from '../../host/mcp/tokens'
import type { MachinesData } from '../../lib/dashboard/machines'
import type { ExternalApp } from '../../lib/external-apps'
import type { ModuleSwitch } from '../../lib/module-switch'
import type { ThemeChoice } from '../../lib/theme'
import type { AuthorizationView } from '../../server/settings'
import { GuardedAwait } from '../error'
import { BoardsSkeleton } from '../skeleton'
import { Appearance } from './appearance'
import { Developer } from './developer'
import { ExternalApps } from './external-apps'
import { General } from './general'
import type { GithubAppProps } from './github-app'
import { Integrations } from './integrations'
import { Machines } from './machines'
import { Modules } from './modules'
import { Network } from './network'
import { Repository } from './repository'

// The body of the Settings tab that is showing, drawn from what the route's
// loader read. Several tabs have one part that streams in behind the page (the
// zones, the live integration checks, the site digests): those tabs draw first
// with that part null, then again once it lands — MaybeAwait is that pattern.
// Machines and Modules have nothing to draw without theirs, so they wait
// behind a skeleton instead.

export type SettingsTabData = {
  theme: ThemeChoice
  settings: BoxSettings
  edit: SiteEdit
  timezones: string[]
  externalApps: ExternalApp[]
  mcpTokens: McpTokenRow[]
  authorization: AuthorizationView | null
  zones: Promise<ZoneList> | null
  integrations: Promise<IntegrationStatus> | null
  site: Promise<SiteState> | null
  machines: Promise<MachinesData> | null
  modules: Promise<ModuleSwitch[]> | null
}

/**
 * A section drawn from a value that may still be streaming: with no promise
 * it is drawn once with null, and with one it is drawn with null until the
 * promise settles and then with the value — the same component either way,
 * so the page does not reflow when the value lands.
 */
function MaybeAwait<T>({
  resetKey,
  slot,
  promise,
  render,
}: {
  resetKey: string
  slot: string
  promise: Promise<T> | null
  render: (value: T | null) => ReactNode
}) {
  if (promise === null) return render(null)
  return (
    <GuardedAwait resetKey={resetKey} slot={slot} promise={promise} fallback={render(null)}>
      {(v) => render(v)}
    </GuardedAwait>
  )
}

export function SettingsTabBody({
  tab,
  data,
  github,
}: {
  tab: string
  data: SettingsTabData
  github: GithubAppProps
}) {
  const { theme, settings, edit, timezones, externalApps, mcpTokens, authorization } = data
  const router = useRouter()
  const [pending, startTransition] = useTransition()
  // The choice is held here as well as in the loader so a click repaints the
  // page immediately. The save is what makes it durable; the router
  // invalidation below is what makes the SERVER agree, which matters because
  // the palette is server-rendered into the document head.
  const [choice, setChoice] = useState(theme)

  return (
    <>
      {tab === 'general' && (
        <MaybeAwait
          resetKey={tab}
          slot="zones"
          promise={data.zones}
          render={(z) => (
            <General settings={settings} edit={edit} timezones={timezones} zones={z} />
          )}
        />
      )}
      {tab === 'network' && <Network settings={settings} edit={edit} />}
      {tab === 'integrations' && (
        <MaybeAwait
          resetKey={tab}
          slot="integrations"
          promise={data.integrations}
          render={(status) => (
            <Integrations
              settings={settings.integrations}
              status={status}
              edit={edit}
              github={github}
            />
          )}
        />
      )}
      {tab === 'repository' && (
        <MaybeAwait
          resetKey={tab}
          slot="site"
          promise={data.site}
          render={(state) => <Repository settings={settings} site={state} edit={edit} />}
        />
      )}
      {tab === 'projects' && <ExternalApps rows={externalApps} />}
      {tab === 'modules' && data.modules !== null && (
        <GuardedAwait
          resetKey={tab}
          slot="modules"
          promise={data.modules}
          fallback={<BoardsSkeleton spans={[12, 12]} />}
        >
          {(rows) => <Modules rows={rows} />}
        </GuardedAwait>
      )}
      {tab === 'machines' && data.machines !== null && (
        <GuardedAwait
          resetKey={tab}
          slot="machines"
          promise={data.machines}
          fallback={<BoardsSkeleton spans={[12, 12, 12]} />}
        >
          {(d) => <Machines d={d} />}
        </GuardedAwait>
      )}
      {tab === 'appearance' && (
        <Appearance
          value={choice}
          saving={pending}
          onChange={(next) => {
            setChoice(next)
            startTransition(async () => {
              const { saveTheme } = await import('../../server/settings')
              await saveTheme({ data: next })
              await router.invalidate()
            })
          }}
        />
      )}
      {tab === 'developer' && authorization !== null && (
        <Developer
          settings={settings}
          edit={edit}
          tokens={mcpTokens}
          authorization={authorization}
        />
      )}
    </>
  )
}
