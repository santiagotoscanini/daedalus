import { createFileRoute } from '@tanstack/react-router'
import { ClaudeView, ShotterView } from '../components/claude'
import { MachinePicker, NodeClaudeView } from '../components/claude-node'
import { GuardedAwait } from '../components/error'
import { PageHead } from '../components/page'
import { BoardsSkeleton, ServiceHeadSkeleton, StripSkeleton } from '../components/skeleton'
import { TabBar } from '../components/tabs'
import { EMPTY } from '../components/tokens'
import { fetchClaude, fetchClaudeNodesFn, fetchNodeClaudeFn } from '../server/claude'

// The Claude page — the foot of the rail, below the divider.
//
// Not a category, and the distinction is the reason it lives there. Every
// entry above it names something this box SERVES; this one names the thing
// that maintains all of them, and folding it into that list would put an
// admin session in the same taxonomy as the photo library.
//
// Two tabs rather than two rail entries, because the second subject belongs
// to the first: Shotter is the sessions' eyes — the headless browser a
// session drives to look at a page — and a rail entry of its own would put
// the tool beside the thing that wields it. Same TabBar and search-param
// shape as the category pages, so the sub-tab survives a refresh and can be
// linked.
//
// A machine picker above the tabs, once another machine runs Claude. The
// agent's tray on a node runs `claude remote-control` the way this box runs
// its own (agent/src/claude.rs), and the same page — the same four questions
// — answers for it, from the node's status page instead of the box's
// snapshot. The picked machine is in the URL like the tab. Shotter stays the
// box's: the browser lab is here.
//
// The loader hands the promise straight through, unawaited, like the category
// pages: the rail and the page frame are on screen the instant you click, and
// the boards stream in behind the skeleton below. One fetch for both tabs —
// the payload was already shared when Shotter was two boards on this page,
// and splitting it would spend a second round of the same upstreams. The node
// list IS awaited: one table read, and the picker is part of the frame.

/**
 * Each tab's opening shape, duplicated from its view for the reason the
 * category pages duplicate theirs: the placeholder has to know the layout
 * before the data exists, and a uniform grid would visibly reflow.
 */
const SPANS = {
  claude: [4, 8, 12, 6, 6],
  shotter: [4, 8, 12],
  node: [6, 6, 12, 6],
} as const

type ClaudeTab = keyof typeof SPANS

const LEDE = {
  claude:
    'The remote-control server that lets this box be worked on from anywhere. What is connected ' +
    'to it, whether it has stayed connected, which version it is running — and every session on ' +
    'the box that could still be asked about.',
  shotter:
    'The headless-browser lab those sessions see through. Every shot invocation, what the last ' +
    'one looked at, and the Playwright underneath it.',
  node:
    'The remote-control server on another machine, run by the agent there in the user’s own ' +
    'session. Whether it is up, which version, the sessions on it, and when its login runs out — ' +
    'as its agent reports it.',
} as const

const NODE_ID = /^[0-9a-f]{16}$/

export const Route = createFileRoute('/claude')({
  validateSearch: (search: Record<string, unknown>): { tab?: 'shotter'; machine?: string } => ({
    tab: search.tab === 'shotter' ? 'shotter' : undefined,
    machine:
      typeof search.machine === 'string' && NODE_ID.test(search.machine)
        ? search.machine
        : undefined,
  }),
  loaderDeps: ({ search }) => ({ machine: search.machine }),
  loader: async ({ deps }) => ({
    nodes: await fetchClaudeNodesFn(),
    claude: fetchClaude(),
    node: deps.machine === undefined ? null : fetchNodeClaudeFn({ data: { id: deps.machine } }),
  }),
  component: ClaudePage,
})

function ClaudePage() {
  const { nodes, claude, node } = Route.useLoaderData()
  const { tab, machine } = Route.useSearch()
  const active: ClaudeTab = node !== null ? 'node' : (tab ?? 'claude')

  return (
    <>
      <PageHead title="Claude">{LEDE[active]}</PageHead>

      <MachinePicker nodes={nodes} active={machine ?? null} />

      {node === null && (
        <TabBar
          tabs={[
            { id: 'claude' as const, label: 'Remote Control' },
            { id: 'shotter' as const, label: 'Shotter' },
          ]}
          active={active}
          linkTo={(id) => ({ to: '/claude', search: id === 'shotter' ? { tab: 'shotter' } : {} })}
        />
      )}

      {node !== null ? (
        <GuardedAwait
          resetKey={machine ?? ''}
          promise={node}
          fallback={
            <>
              <ServiceHeadSkeleton />
              <StripSkeleton count={4} />
              <BoardsSkeleton spans={[...SPANS.node]} />
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
      ) : (
        <GuardedAwait
          resetKey={active}
          promise={claude}
          fallback={
            <>
              <ServiceHeadSkeleton />
              {/* Both views open with a `StatStrip` of four readings, so that is
                  the shape reserved. It was a stat BAND's, which is a taller box
                  nothing on this page has drawn since the strip replaced it. */}
              <StripSkeleton count={4} />
              <BoardsSkeleton spans={[...SPANS[active === 'node' ? 'claude' : active]]} />
            </>
          }
        >
          {(data) =>
            active === 'shotter' ? <ShotterView data={data} /> : <ClaudeView data={data} />
          }
        </GuardedAwait>
      )}
    </>
  )
}
