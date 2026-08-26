import { Await, createFileRoute } from '@tanstack/react-router'

import { ClaudeView, ShotterView } from '../components/claude'
import { BoardsSkeleton, ServiceHeadSkeleton, StatBandSkeleton } from '../components/skeleton'
import { TabBar } from '../components/tabs'
import { fetchClaude } from '../server/claude'

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
// The loader hands the promise straight through, unawaited, like the category
// pages: the rail and the page frame are on screen the instant you click, and
// the boards stream in behind the skeleton below. One fetch for both tabs —
// the payload was already shared when Shotter was two boards on this page,
// and splitting it would spend a second round of the same upstreams.

/**
 * Each tab's opening shape, duplicated from its view for the reason the
 * category pages duplicate theirs: the placeholder has to know the layout
 * before the data exists, and a uniform grid would visibly reflow.
 */
const SPANS = {
  claude: [4, 8, 6, 6],
  shotter: [4, 8, 12],
} as const

type ClaudeTab = keyof typeof SPANS

const LEDE = {
  claude:
    'The remote-control server that lets this box be worked on from anywhere. What is connected ' +
    'to it, whether it has stayed connected, and which version it is running.',
  shotter:
    'The headless-browser lab those sessions see through. Every shot invocation, what the last ' +
    'one looked at, and the Playwright underneath it.',
} as const

export const Route = createFileRoute('/claude')({
  validateSearch: (search: Record<string, unknown>): { tab?: 'shotter' } => ({
    tab: search.tab === 'shotter' ? 'shotter' : undefined,
  }),
  loader: () => ({ claude: fetchClaude() }),
  component: ClaudePage,
})

function ClaudePage() {
  const { claude } = Route.useLoaderData()
  const { tab } = Route.useSearch()
  const active: ClaudeTab = tab ?? 'claude'

  return (
    <>
      <header className="page-head">
        <h1>Claude</h1>
      </header>
      <p className="lede cat-lede">{LEDE[active]}</p>

      <TabBar
        tabs={[
          { id: 'claude' as const, label: 'Remote Control' },
          { id: 'shotter' as const, label: 'Shotter' },
        ]}
        active={active}
        linkTo={(id) => ({ to: '/claude', search: id === 'shotter' ? { tab: 'shotter' } : {} })}
      />

      <Await
        promise={claude}
        fallback={
          <>
            <ServiceHeadSkeleton />
            <StatBandSkeleton />
            <BoardsSkeleton spans={[...SPANS[active]]} />
          </>
        }
      >
        {(data) =>
          active === 'shotter' ? <ShotterView data={data} /> : <ClaudeView data={data} />
        }
      </Await>
    </>
  )
}
