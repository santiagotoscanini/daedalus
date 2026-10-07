import { TabBar } from '../tabs'

/** Every section an app page can show, in rail order. Mirrors APP_TABS in
    routes/apps.$name.tsx (which cannot be imported here without a cycle). */
const TAB_IDS = [
  'overview',
  'deployments',
  'database',
  'vpn',
  'tasks',
  'access',
  'settings',
  'variables',
  'secrets',
  'logs',
] as const
export type AppTabId = (typeof TAB_IDS)[number]

/**
 * The app's sections as a scrolling tab row, for the widths where the rail is a
 * drawer (below `rail`, 52rem). Above that the rail carries them and this row
 * would say the same thing twice, so it is not drawn.
 *
 * Database and VPN appear only for an app that has them, as in the rail.
 */
export function AppTabRow({
  name,
  active,
  hasDatabase,
  hasVpn,
}: {
  name: string
  active: AppTabId
  hasDatabase: boolean
  hasVpn: boolean
}) {
  const tabs = TAB_IDS.filter(
    (t) => (t !== 'database' || hasDatabase) && (t !== 'vpn' || hasVpn),
  ).map((t) => ({ id: t, label: t.charAt(0).toUpperCase() + t.slice(1) }))
  return (
    <div className="-mt-3 rail:hidden">
      <TabBar
        tabs={tabs}
        active={active}
        linkTo={(id) => ({
          to: '/apps/$name',
          params: { name },
          search: (prev: Record<string, unknown>) => ({ ...prev, tab: id }),
        })}
      />
    </div>
  )
}
