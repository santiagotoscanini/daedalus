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
  /** Empty when the category has no sub-tabs. */
  tabs: { id: string; label: string }[]
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
    boardSpans: [8, 4, 6, 6],
    tileGroups: 1,
    tabs: [],
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
    boardSpans: [6, 6, 12, 12],
    tileGroups: 0,
    tabs: [
      { id: "factorio", label: "Factorio" },
      { id: "minecraft", label: "Minecraft" },
    ],
  },
  {
    id: "network",
    label: 'Network',
    icon: '⇄',
    lede: 'Everything between a packet and this box — the link, the ways in, the proxy, the resolver.',
    boardSpans: [8, 4, 6, 6],
    tileGroups: 1,
    tabs: [],
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
