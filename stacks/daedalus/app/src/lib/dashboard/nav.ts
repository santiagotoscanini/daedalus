// The category rail.
//
// Kept out of server/category.ts deliberately: the sidebar renders this on
// every page, and importing it from the server module would drag that module
// (and the shape of everything it imports) into the browser bundle for the
// sake of five labels.

import type { CategoryName } from './tiles'

export type CategorySpec = {
  id: CategoryName
  label: string
  icon: string
  lede: string
  /**
   * A path under public/ instead of a glyph, for the one category whose
   * subject has real artwork. Rendered at the same box size as a glyph.
   */
  iconImage?: string
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
     * opens differently reflows on arrival. `statBand: false` is the sharper
     * case: a placeholder for four stat cards that never come is not a
     * mis-sized skeleton, it is a promise the page then breaks.
     */
    boardSpans?: number[]
    statBand?: boolean
    /**
     * How many tile groups this tab shows, when it differs from the category's.
     *
     * A tile GROUP is scoped to a tab in `tiles.ts`; this is the skeleton's
     * copy of that fact, and `0` is the one that matters — it stops a
     * placeholder appearing for a directory the tab does not have.
     */
    tileGroups?: number
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
    health?: 'vpn-egress'
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
  /**
   * How many tile groups sit under this category, for the placeholder.
   * Zero is a real answer — Gaming and System are covered entirely by their
   * boards — and without it the skeleton draws group headings that resolve
   * into nothing, which flashes a section that never arrives.
   *
   * Restated here rather than derived from GROUPS because that lives in
   * tiles.ts, whose imports reach the server clients; pulling it into the
   * sidebar would drag all of that into the browser bundle.
   */
  tileGroups: number
}

export const CATEGORIES: CategorySpec[] = [
  {
    id: 'ai',
    label: 'AI',
    icon: '◈',
    lede: 'The local model server, the gateway in front of it, and what is driving traffic through it.',
    // Shaped to Lemonade, the tab that opens by default: the model list and
    // the release notes side by side, then the logs across the bottom.
    boardSpans: [6, 6, 12],
    // No tile directory. It held one tile per service, and each of those is
    // now a tab on this page — the same name, dot, description and link, one
    // scroll further down.
    tileGroups: 0,
    // A tab per service, in the order a prompt travels: the thing that holds
    // the weights, the gateway in front of it, then the two callers. Lemonade
    // leads because it is the one that is off this box and the one whose state
    // (what is resident, is the card full) actually changes hour to hour.
    tabs: [
      { id: 'lemonade', label: 'Lemonade', probe: 'lemonade' },
      // The one tab here with no headline band: its numbers live inside the
      // panel whose chart they describe.
      // Traffic + the tool list, then who is calling + the changelog. Paired
      // by height rather than by subject — see the note on that board.
      { id: 'litellm', label: 'LiteLLM', probe: 'litellm', boardSpans: [8, 4, 4, 8], statBand: false },
      // What it can reach + who gets in, then the changelog across.
      { id: 'open-webui', label: 'Open WebUI', probe: 'open-webui', boardSpans: [6, 6, 12], statBand: false },
      // Runs + the workflows behind them, same 8/4 pairing as the gateway.
      { id: 'n8n', label: 'n8n', probe: 'n8n', boardSpans: [8, 4, 12], statBand: false },
    ],
  },
  {
    id: "media",
    label: 'Media',
    icon: '▶',
    lede: 'What is playing, what is downloading, and what the library has become.',
    boardSpans: [12, 8, 4, 6],
    tileGroups: 1,
    tabs: [
      { id: 'tv', label: 'TV & Film' },
      { id: 'books', label: 'Books' },
    ],
  },
  {
    id: 'home',
    label: 'Home',
    icon: '⌂',
    lede: 'The household: automation, photos, files, the pantry, and who can sign in.',
    boardSpans: [8, 4, 6, 6],
    tileGroups: 1,
    tabs: [],
  },
  {
    id: "gaming",
    label: 'Gaming',
    icon: '⛶',
    lede: "The game servers: which build each one runs, and whether the people on the sofa can still join.",
    boardSpans: [6, 6, 12],
    tileGroups: 0,
    tabs: [
      // ofsm answering is the closest thing to a liveness check this server
      // has: the game itself speaks UDP straight to a forwarded port and
      // nothing on this box can ask it a question.
      { id: "factorio", label: "Factorio", probe: "factorio-admin" },
      // No server, so no probe — grey, and correctly so.
      { id: "minecraft", label: "Minecraft" },
    ],
  },
  {
    id: "network",
    label: 'Network',
    icon: '⇄',
    lede: 'Everything between a packet and this box — the link, the ways in, the proxy, the resolver.',
    boardSpans: [12, 12, 8, 4],
    tileGroups: 1,
    // Split by DIRECTION, because that is the only axis on which these two
    // are alike: both are WireGuard, both are tunnels, and everything else
    // about them is opposite. One lets a phone reach the house from a hotel;
    // the other stops the house being recognised from outside. Keeping them
    // as two boards on one page meant the words "VPN", "WireGuard" and
    // "tunnel" each meant two things a scroll apart.
    tabs: [
      { id: 'general', label: 'General' },
      // Three ways in — WireGuard, the Cloudflare tunnel, and the address
      // itself — chosen by a switch inside the page. The probe is wg-easy's
      // because it is the only one of the three gatus can check.
      { id: 'wireguard', label: 'Coming in', probe: 'wg-easy', boardSpans: [8, 4, 12], statBand: false, tileGroups: 0 },
      // What happens to a request once it has arrived: traefik terminates it,
      // Pocket ID decides whether it goes any further. Two services, one tab,
      // because neither answers "can this be reached" alone — a route with no
      // gate and a gate with no route are the same page read from two ends.
      // The probe is traefik's dashboard, the only one of the two that can go
      // down without taking the probe path with it.
      {
        id: 'gateway',
        label: 'Gateway',
        probes: ['traefik-dashboard', 'pocket-id'],
        boardSpans: [12, 8, 4],
        statBand: false,
        tileGroups: 0,
      },
      // No gatus probe: it checks HTTP endpoints, and a VPN egress tunnel
      // answers nothing — it is a network namespace. Its dot is computed from
      // every declared tunnel's state and its containers instead.
      {
        id: 'outbound',
        label: 'Going out',
        health: 'vpn-egress',
        boardSpans: [8, 4, 12],
        statBand: false,
        tileGroups: 0,
      },
    ],
  },
  {
    id: "system",
    label: 'System',
    icon: '◔',
    lede: 'The machine itself, and whether anything running on it is unhappy.',
    boardSpans: [6, 6, 6, 6],
    tileGroups: 0,
    tabs: [],
  },
  {
    id: 'monitoring',
    label: 'Monitoring',
    icon: '◎',
    lede: 'The watchers: what is firing, what is being collected, and what has gone quiet.',
    boardSpans: [6, 6, 8, 4],
    tileGroups: 1,
    tabs: [],
  },
]
