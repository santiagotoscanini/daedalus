// The category page's chrome around its boards: the tab bar with its health
// dots, the placeholder while boards stream in, and a node's head strip.

import { useLoaderData } from '@tanstack/react-router'
import type { NodeSystemData } from '../lib/dashboard/node-system'
import { isDotted, nixModulesOf, type PageSpec } from '../lib/modules/manifest'
import { MachineHead } from '../modules/system/view/node'
import type { TabStatus } from '../server/tab-status'
import { StateDot } from './controls'
import { GuardedAwait } from './error'
import { ServiceSettingsButton } from './service-settings'
import { BoardsSkeleton, HeadStripSkeleton, ServiceHeadSkeleton } from './skeleton'
import { TabBar } from './tabs'

/**
 * The sub-tab row, optionally wearing each tab's status.
 *
 * `status === null` covers both "this module has no probes" and "they have
 * not landed yet". The dot is drawn in the second case and not the first,
 * which is why the caller decides rather than this component: a grey dot is a
 * claim ("nothing is probing this"), and a module that never had one should
 * not appear to be making it.
 */
export function TabNav({
  spec,
  category,
  tab,
  status,
}: {
  spec: PageSpec
  category: string
  tab: string
  status: TabStatus | null
}) {
  // isDotted, not `probe` alone — the loader's tabStatus comment says why.
  const dotted = spec.tabs.some(isDotted)
  // Which tabs are switched off on this box: the server marks them on the
  // rail's copy of the manifest (lib/modules/active.ts), read here from the
  // root loader so the tabs say it before their boards — which an off tab
  // never fetches — could.
  const off = useLoaderData({
    from: '__root__',
    select: (d) =>
      new Set(
        (d.modules.find((m) => m.id === spec.id)?.tabs ?? [])
          .filter((t) => t.off === true)
          .map((t) => t.id),
      ),
  })
  const current = spec.tabs.find((t) => t.id === tab)
  const fronts = current === undefined ? [] : nixModulesOf(current)

  return (
    <TabBar
      tabs={spec.tabs.map((t) => {
        const up = status?.[t.id] ?? null
        const isOff = off.has(t.id)
        return {
          id: t.id,
          label: t.label,
          dividerBefore: t.dividerBefore,
          muted: isOff,
          // No icons in a tab row: the label names the tab. An off tab wears a
          // grey dot titled "switched off" — the tab is dimmed too, so the
          // dot and the dimming say it together without a pill in the label.
          // A tab nothing probes gets no dot at all rather than a grey claim.
          extra: isOff ? (
            <StateDot state="stopped" label="off" title="switched off on this box" />
          ) : dotted && isDotted(t) ? (
            <StateDot
              state={up === null ? 'unknown' : up ? 'running' : 'attention'}
              label={up === null ? 'status unknown' : up ? 'up' : 'not answering'}
              title={
                up === null
                  ? 'no reading from gatus'
                  : up
                    ? 'answering'
                    : 'nothing has answered in the last few minutes'
              }
            />
          ) : undefined,
        }
      })}
      active={tab}
      linkTo={(id) => ({ to: '/c/$category', params: { category }, search: { tab: id } })}
      trailing={<ServiceSettingsButton ids={fronts} />}
    />
  )
}

/**
 * The service header and the grid, sized to the page that is arriving.
 *
 * Sized per TAB where a tab says so: the module's own spans describe its
 * default tab, and a sibling laid out differently would reflow on arrival.
 *
 * The header is the same argument one level up. Almost every tab opens with
 * one, and without a placeholder for it the boards render at the top of the
 * page and are then pushed down by its height the instant the loader resolves.
 * `head: false` is the honest opt-out for the tabs whose subject is not a
 * service — see `TabSpec.head`.
 */
export function BoardsPlaceholder({ spec, tab }: { spec: PageSpec; tab: string }) {
  const t = spec.tabs.find((x) => x.id === tab)

  return (
    <>
      {t?.head !== false && <ServiceHeadSkeleton />}
      <BoardsSkeleton spans={t?.boardSpans ?? spec.boardSpans} />
    </>
  )
}

/** The node's head strip, behind a skeleton of its own size while the agent answers. */
export function NodeHead({
  promise,
  resetKey,
}: {
  promise: Promise<NodeSystemData | null> | null
  resetKey: string
}) {
  if (promise === null) return null
  return (
    <GuardedAwait
      resetKey={resetKey}
      slot="head"
      promise={promise}
      fallback={<HeadStripSkeleton />}
    >
      {(d) => (d === null ? null : <MachineHead d={d} />)}
    </GuardedAwait>
  )
}
