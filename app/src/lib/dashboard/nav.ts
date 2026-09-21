// The category rail.
//
// Kept out of server/category.ts deliberately: the sidebar renders this on
// every page, and importing it from the server module would drag that module
// (and the shape of everything it imports) into the browser bundle for the
// sake of five labels.
//
// No icon on the spec: the rail draws one per `id` (components/nav-icon.tsx),
// and naming it here as well was the same fact written twice.

/**
 * The categories, and the only list of them.
 *
 * It lived in the tile catalogue until that catalogue emptied: every service
 * on this box now has a TAB, so a directory of cards restating three of its
 * numbers one scroll below its own page had nothing left to hold. The last
 * five were Grafana, Loki, Prometheus, Gatus and Healthchecks — which is the
 * Monitoring tab row exactly.
 */

export type CategorySpec = {
  id: CategoryName
  label: string
  lede: string
  /**
   * Empty when the category has no sub-tabs.
   *
   * `probe` is a gatus endpoint name — the tab wears its subject's status as
   * a dot, so a category of several servers answers "which of these is up"
   * from the tab row, without visiting each one. It is on the TAB rather than
   * inside the page for exactly that reason: a status you have to navigate to
   * is a status you check one at a time.
   *
   * Omitted means there is nothing probing that tab's subject, which is not
   * the same claim as "down" and is drawn grey. Dots appear only in a
   * category where at least one tab declares one — Media's TV/Books split is
   * a view of one library, not two services, and would sprout two permanently
   * grey dots for nothing.
   */
  tabs: {
    id: string
    label: string
    probe?: string
    /**
     * Several probes that must ALL be green, for a tab whose subject is more
     * than one service.
     *
     * The Gateway tab is the case: traefik routes and Pocket ID authorises,
     * and either one down means requests are not getting where they were
     * going. Picking one of the two to represent the pair would draw a green
     * dot over a broken half. Unknown on any of them makes the whole thing
     * unknown — a partial answer to "is this working" is not an answer.
     */
    probes?: string[]
    /**
     * This tab's own opening shape, when it differs from the category's.
     *
     * The category-level `boardSpans` are the DEFAULT tab's, so a sibling that
     * opens differently reflows on arrival.
     *
     * A `statBand` flag used to sit beside this one, opting a tab out of a
     * placeholder for the headline band of stat cards. Three tabs never set it
     * and so drew four grey cards that were replaced by nothing — no page
     * draws that band any more. The band, its placeholder and the flag went
     * together, rather than the flag gaining three more `false`s.
     */
    boardSpans?: number[]
    /**
     * Draw a rule before this tab.
     *
     * For a category whose tabs answer two different KINDS of question. Media
     * is the case: Jellyfin and Calibre are where a pipeline ends — the
     * libraries a person opens — and everything after the rule is machinery
     * that fills them. Without it the two read as the first two stages of the
     * chain rather than as its destination.
     */
    dividerBefore?: boolean
    /**
     * Whether this tab opens with a `ServiceHead`. Default true.
     *
     * Almost every tab on this dashboard does: its subject is a service, so it
     * gets artwork, the name, the version running, the verdict on whether that
     * version is current, and the link you came to click. The exceptions are
     * the tabs whose subject is not a service at all — the System layers, and
     * Network's General, which is the wire.
     *
     * Declared here rather than left implicit in the view, because the
     * SKELETON has to know it before the data exists. A page that streams a
     * header in above a grid that was already drawn pushes the whole grid down
     * at the moment you have started reading it.
     */
    head?: boolean
    /**
     * A COMPUTED status, for a tab gatus cannot probe.
     *
     * `probe` covers anything that answers HTTP. A VPN egress tunnel answers
     * nothing — it is a network namespace — so its health has to be assembled
     * from what prometheus knows about it, and from the registry that says how
     * many tunnels there should be. A symbol rather than a query string
     * because that assembly needs the registry, which lives on the server;
     * this file is imported into the browser bundle for five labels and must
     * stay data.
     */
    health?: 'vpn-egress' | 'uplink' | 'log-pipeline'
  }[]
  /**
   * Column spans of this page's boards, for the skeleton that stands in while
   * they load.
   *
   * Duplicated from the view component on purpose, and the duplication is the
   * cheap half of the trade: the placeholder has to know the shape before the
   * data exists, and a uniform grid of six would visibly reflow into an 8+4 on
   * every page here. Only the first few matter — the fold is around four
   * boards — so this is not a mirror of the whole layout, just its opening.
   */
  boardSpans: number[]
}

export const CATEGORIES: CategorySpec[] = [
  {
    tabs: [
      {
        boardSpans: [8, 4, 4, 8],
      },
      {
      },
    ],
  },
  // No Security category. It held exactly one tab — Pocket ID — and the
  // argument that gave it one was an argument against living on Network: an
  // IdP is not infrastructure with a release cycle, it is the account every
  // person in the house signs in with. True, and it does not make it a
  // subject of its own. Beside the automation, the photos and the files it is
  // plainly one of the household's things, so it is Home › Sign-in now.
  {
    //
    //
    tabs: [
      {
      },
      {
        boardSpans: [8, 4, 8, 4],
      },
    ],
  },
]

/**
 * Is this one of the categories, as a request may claim?
 *
 * Over CATEGORIES rather than over a second list of the same seven names. The
 * server functions index `LOADERS` with the result, and `LOADERS[x]` for an x
 * that is not a category is `undefined()` — a TypeError three frames below the
 * request that said it.
 */
export const isCategoryName = (v: unknown): v is CategoryName => CATEGORIES.some((c) => c.id === v)

/**
 * Resolve a requested sub-tab against what a category actually declares:
 * the tab if it exists, the category's first tab otherwise. Lives beside
 * CATEGORIES because both the route loader and the server functions need
 * the SAME answer — two copies of this rule is how a URL renders one tab
 * while the server loads another.
 */
export function resolveTab(category: string, tab: string | undefined): string {
  const spec = CATEGORIES.find((c) => c.id === category)
  if (spec === undefined) return ''
  return tab !== undefined && spec.tabs.some((t) => t.id === tab) ? tab : (spec.tabs[0]?.id ?? '')
}
