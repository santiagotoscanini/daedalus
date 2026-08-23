import { Await, createFileRoute } from '@tanstack/react-router'

import { ClaudeView } from '../components/claude'
import { BoardsSkeleton, ServiceHeadSkeleton, StatBandSkeleton } from '../components/skeleton'
import { fetchClaude } from '../server/claude'

// The Claude page — the foot of the rail, below the divider.
//
// Not a category, and the distinction is the reason it lives there. Every
// entry above it names something this box SERVES; this one names the thing
// that maintains all of them, and folding it into that list would put an
// admin session in the same taxonomy as the photo library.
//
// A route of its own rather than a tab under Apps for the same reason and one
// more: it has exactly one subject, so it has no tab row, and everything on
// it fits a single page.
//
// The loader hands the promise straight through, unawaited, like the category
// pages: the rail and the page frame are on screen the instant you click, and
// the boards stream in behind the skeleton below.

/**
 * The opening shape, duplicated from the view for the reason the category
 * pages duplicate theirs: the placeholder has to know the layout before the
 * data exists, and a uniform grid would visibly reflow into the 4+8 this page
 * opens with.
 */
const BOARD_SPANS = [4, 8, 6, 6]

export const Route = createFileRoute('/claude')({
  loader: () => ({ claude: fetchClaude() }),
  component: ClaudePage,
})

function ClaudePage() {
  const { claude } = Route.useLoaderData()

  return (
    <>
      <header className="page-head">
        <h1>Claude</h1>
      </header>
      <p className="lede cat-lede">
        The remote-control server that lets this box be worked on from anywhere. What is connected
        to it, whether it has stayed connected, and which version it is running.
      </p>

      <Await
        promise={claude}
        fallback={
          <>
            <ServiceHeadSkeleton />
            <StatBandSkeleton />
            <BoardsSkeleton spans={BOARD_SPANS} />
          </>
        }
      >
        {(data) => <ClaudeView data={data} />}
      </Await>
    </>
  )
}
