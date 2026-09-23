import { createFileRoute, notFound } from '@tanstack/react-router'
import { NodeClaudeView } from '../components/claude-node'
import { StateDot } from '../components/controls'
import { GuardedAwait } from '../components/error'
import { MachinePicker } from '../components/machine-picker'
import {
  BoxHead,
  MachineHead,
  MachineSystemView,
  type NodeTabId,
  nodeTabsFor,
  resolveNodeTab,
} from '../components/machine-system'
import { ModuleBoards } from '../components/modules/boards'
import { PageHead } from '../components/page'
import {
  BoardsSkeleton,
  HeadStripSkeleton,
  ServiceHeadSkeleton,
  StripSkeleton,
} from '../components/skeleton'
import { TabBar } from '../components/tabs'
import { EMPTY } from '../components/tokens'
import type { NodeSystemData } from '../lib/dashboard/node-system'
import { known } from '../lib/known'
import { isDotted, type PageSpec, resolveTabOf } from '../lib/modules/manifest'
import { moduleById } from '../lib/modules/registry'
import { fetchNodeClaudeFn } from '../server/claude'
import { fetchBoxHeadFn, fetchMachineNodesFn, fetchNodeSystemFn } from '../server/machines'
import { fetchModuleBoards } from '../server/modules'
import { fetchTabStatus, type TabStatus } from '../server/tab-status'

// One page per module, and a tab per subject inside it.
//
// The split is by *subject*, not by service: someone opening Media wants to
// know what is playing and what is downloading, and does not care that those
// two facts come from six containers.
//
// The URL segment is still `/c/<id>` — the modules were categories before
// they were directories, and every bookmark and rail link says `c`.
//
// ── nothing here blocks the navigation ────────────────────────────────────
//
// The loader returns UNAWAITED promises. That is the whole design: the page
// frame — title, lede, sub-tabs — comes from the module's manifest and is on
// screen the instant you click, while the boards stream in behind their own
// skeleton.
//
// The router still caches a resolved loader result for `defaultStaleTime`, so
// coming back to a page you just left renders complete, with no skeleton
// flash — the placeholders appear only when something is actually being
// fetched.

const NODE_ID = /^[0-9a-f]{16}$/

export const Route = createFileRoute('/c/$category')({
  // Same reasoning as the app detail page: the sub-tab is in the URL so it
  // survives a refresh, can be linked, and renders on the server. So is the
  // picked machine, on the one module that has a picker.
  validateSearch: (search: Record<string, unknown>): { tab?: string; machine?: string } => ({
    tab: typeof search.tab === 'string' ? search.tab : undefined,
    machine:
      typeof search.machine === 'string' && NODE_ID.test(search.machine)
        ? search.machine
        : undefined,
  }),
  loaderDeps: ({ search }) => ({ tab: search.tab, machine: search.machine }),
  loader: async ({ params, deps }) => {
    const spec = moduleById(params.category)
    // An unknown module is a 404, not an empty page: the rail cannot produce
    // one, so anything else got here by hand-editing the URL.
    if (spec === undefined) throw notFound()

    const tab = resolveTabOf(spec, deps.tab)
    const picker = spec.machinePicker === true
    // A node only makes sense on a module with a picker; elsewhere the
    // search param is ignored rather than honoured.
    const machine = picker ? (deps.machine ?? null) : null
    // The node list is part of the frame — the picker, and which OS the
    // picked machine runs, which is what shapes its tab row
    // (components/machine-system/index.tsx) — so it is awaited: from this
    // browser's memory past the first visit (lib/known.ts), compared on
    // what the picker draws, since "last seen" moves on every read.
    const nodes = picker
      ? await known('machines', fetchMachineNodesFn, (ns) =>
          ns.map((n) => [n.id, n.name, n.os, n.state, n.claude?.sessions ?? 0].join()).join(';'),
        )
      : []
    const nodeOs = machine === null ? null : (nodes.find((n) => n.id === machine)?.os ?? 'windows')
    // The node's tabs share the box's ids where the subject is the same, so
    // `?tab=memory` names the memory of whichever machine is picked; an id
    // this machine lacks opens the nearest subject it has.
    const nodeTab: NodeTabId | null = nodeOs === null ? null : resolveNodeTab(nodeOs, deps.tab)

    return {
      spec,
      tab,
      nodes,
      nodeOs,
      // The strip above the box's tabs, part of the frame too, remembered the same way.
      boxHead: picker && machine === null ? await known('boxHead', fetchBoxHeadFn) : null,
      machine,
      nodeTab,
      // A node's document is fetched on every tab: it is what the head strip
      // reads, and a strip that said less on the Claude tab than on Host read
      // as a page that had not finished. The Claude tab adds its report (the
      // tray's picture of the remote-control server) for its boards.
      node:
        machine === null
          ? null
          : fetchNodeSystemFn({
              data: {
                id: machine,
                board: nodeTab === 'board',
                browsers: nodeTab === 'browsers',
                macos: nodeTab === 'macos',
              },
            }),
      nodeClaude:
        machine !== null && nodeTab === 'claude'
          ? fetchNodeClaudeFn({ data: { id: machine } })
          : null,
      // The box's boards are not fetched behind a node's page: the picker
      // switched the subject, and a dozen prometheus queries for a page
      // nobody is reading is the cost of pretending it did not.
      boards: machine === null ? fetchModuleBoards({ data: { module: spec.id, tab } }) : null,
      // Only where a tab actually wears a dot. All three ways of declaring one
      // count; testing `probe` alone would skip the request for a module whose
      // tabs each hold several services, and then draw grey dots over health
      // it had chosen not to fetch.
      tabStatus: spec.tabs.some(isDotted) ? fetchTabStatus({ data: { module: spec.id } }) : null,
    }
  },
  component: CategoryPage,
})

function CategoryPage() {
  const {
    spec,
    tab,
    boards,
    tabStatus,
    nodes,
    nodeOs,
    boxHead,
    machine,
    nodeTab,
    node,
    nodeClaude,
  } = Route.useLoaderData()
  const { category } = Route.useParams()
  // Switching module or tab clears a caught failure; staying put does not,
  // so a section that failed stays failed until its loader is re-run.
  const sectionKey = `${category}/${tab}/${machine ?? ''}`
  // The node tab's own shape, for its skeleton; `head` is set on the tabs
  // that open with a ServiceHead (Chromium), as the box's manifest does.
  const nodeTabs = nodeOs === null ? [] : nodeTabsFor(nodeOs)
  const nodeSpec = nodeTabs.find((t) => t.id === nodeTab)

  return (
    <>
      {/* The same lede whichever machine is picked: a second sentence for a
          node once wrapped to two lines and moved every tab below it. */}
      <PageHead title={spec.label}>{spec.lede}</PageHead>

      {spec.machinePicker === true && <MachinePicker nodes={nodes} active={machine} tab={tab} />}

      {nodeTab !== null ? (
        <>
          {/* The strip first, then the tabs, as on the box. It waits for the
              node's answer behind a skeleton of its own size, so the tabs
              below never move and never wait. */}
          <NodeHead promise={node} resetKey={sectionKey} />
          <TabBar
            tabs={nodeTabs.map((t) => ({
              id: t.id,
              label: t.label,
              icon: t.icon,
              dividerBefore: t.dividerBefore,
            }))}
            active={nodeTab}
            linkTo={(id) => ({
              to: '/c/$category',
              params: { category },
              search: { tab: id, machine: machine ?? undefined },
            })}
          />
          {nodeClaude !== null ? (
            <GuardedAwait
              resetKey={sectionKey}
              slot="claude"
              promise={nodeClaude}
              fallback={
                <>
                  <ServiceHeadSkeleton />
                  <StripSkeleton count={4} />
                  <BoardsSkeleton spans={[6, 6, 12, 6]} />
                </>
              }
            >
              {(d) =>
                d === null ? (
                  <p className={EMPTY}>No machine with that id. It may have been forgotten.</p>
                ) : (
                  <NodeClaudeView d={d} />
                )
              }
            </GuardedAwait>
          ) : node !== null ? (
            <GuardedAwait
              resetKey={sectionKey}
              slot="node"
              promise={node}
              fallback={
                <>
                  {nodeSpec?.head === true && <ServiceHeadSkeleton />}
                  <BoardsSkeleton spans={[...(nodeSpec?.boardSpans ?? [8, 4, 4])]} />
                </>
              }
            >
              {(d) =>
                d === null ? (
                  <p className={EMPTY}>No machine with that id. It may have been forgotten.</p>
                ) : (
                  <MachineSystemView d={d} tab={nodeTab} />
                )
              }
            </GuardedAwait>
          ) : null}
        </>
      ) : (
        <>
          {boxHead !== null && <BoxHead h={boxHead} />}
          {spec.tabs.length > 0 &&
            (tabStatus === null ? (
              <TabNav spec={spec} category={category} tab={tab} status={null} />
            ) : (
              // The tabs are drawn immediately either way — navigation is the one
              // thing on this page that must never wait. The dot arrives in its
              // reserved slot, grey until it is known, so nothing moves.
              //
              // Guarded, like the boards below: this is the single render path for
              // every module and every tab, and it fans out over a dozen
              // upstreams. An unguarded rejection here throws past the Suspense
              // fallback and blanks the whole dashboard — one dead upstream must
              // cost its own row of dots, not the page.
              <GuardedAwait
                resetKey={sectionKey}
                slot="tabs"
                promise={tabStatus}
                fallback={<TabNav spec={spec} category={category} tab={tab} status={null} />}
              >
                {(status) => <TabNav spec={spec} category={category} tab={tab} status={status} />}
              </GuardedAwait>
            ))}

          {boards !== null && (
            <GuardedAwait
              resetKey={sectionKey}
              slot="boards"
              promise={boards}
              fallback={<BoardsPlaceholder spec={spec} tab={tab} />}
            >
              {(payload) => <ModuleBoards payload={payload} />}
            </GuardedAwait>
          )}
        </>
      )}
    </>
  )
}

/**
 * The sub-tab row, optionally wearing each tab's status.
 *
 * `status === null` covers both "this module has no probes" and "they have
 * not landed yet". The dot is drawn in the second case and not the first,
 * which is why the caller decides rather than this component: a grey dot is a
 * claim ("nothing is probing this"), and a module that never had one should
 * not appear to be making it.
 */
function TabNav({
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
  // `probes` counts as much as `probe`. A module whose tabs all hold several
  // services would otherwise render no dots at all — the tab knows its health
  // and silently declines to show it.
  const dotted = spec.tabs.some(isDotted)

  return (
    <TabBar
      tabs={spec.tabs.map((t) => {
        const up = status?.[t.id] ?? null
        return {
          id: t.id,
          label: t.label,
          dividerBefore: t.dividerBefore,
          icon: t.icon,
          extra: dotted ? (
            <StateDot
              state={up === null ? 'unknown' : up ? 'running' : 'attention'}
              label={up === null ? 'status unknown' : up ? 'up' : 'not answering'}
              title={
                !isDotted(t)
                  ? 'nothing probes this yet'
                  : up === null
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
function BoardsPlaceholder({ spec, tab }: { spec: PageSpec; tab: string }) {
  const t = spec.tabs.find((x) => x.id === tab)

  return (
    <>
      {t?.head !== false && <ServiceHeadSkeleton />}
      <BoardsSkeleton spans={t?.boardSpans ?? spec.boardSpans} />
    </>
  )
}

/** The node's head strip, behind a skeleton of its own size while the agent answers. */
function NodeHead({
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
