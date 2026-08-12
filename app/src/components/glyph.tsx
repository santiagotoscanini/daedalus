// The board-title glyphs, drawn for the same reason the rail's are (see
// nav-icon.tsx): a typed Unicode glyph comes from whatever font the browser
// has for that codepoint, at its own weight and its own baseline. One viewBox
// and one stroke width is what makes a page of boards read as one set.
//
// A separate file from NavIcon on that file's own rule — its names are the
// category ids and nothing else, and these are pictographs. Named by shape,
// not subject: "clock" captions queues, schedules and history alike, and a
// name like "queue" would be wrong on two of them.
//
// Only the repeated glyphs are here. The tail is long — sixty-odd codepoints
// used once or twice each — and sixty drawings is not a set anyone maintains,
// so `Board` renders an unknown name as literal text and the tail stays typed.

import type { ReactNode } from 'react'

export type GlyphName =
  | 'rows'
  | 'clock'
  | 'grid'
  | 'logs'
  | 'warn'
  | 'panels'
  | 'key'
  | 'hash'
  | 'down'

const PATHS: Record<GlyphName, ReactNode> = {
  // A table: header rule and body rules in one frame.
  rows: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M3.5 9.5h17M3.5 14.5h17" />
    </>
  ),
  clock: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M12 7.2V12l3.4 2.3" />
    </>
  ),
  // Four cells: storage, libraries, anything counted in blocks.
  grid: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2" />
      <path d="M12 3.5v17M3.5 12h17" />
    </>
  ),
  // The rail's menu shape, doing its other job: lines of text.
  logs: <path d="M4 7h16M4 12h16M4 17h16" />,
  warn: (
    <>
      <path d="M10.6 5.1 3.5 17.7a1.7 1.7 0 0 0 1.5 2.5h14a1.7 1.7 0 0 0 1.5-2.5L13.4 5.1a1.6 1.6 0 0 0-2.8 0Z" />
      <path d="M12 10.2v4M12 17h.01" />
    </>
  ),
  // A split frame: things side by side — columns, tenants, comparisons.
  panels: (
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
      <path d="M12 4.5v15" />
    </>
  ),
  key: (
    <>
      <circle cx="7.8" cy="12" r="3.4" />
      <path d="M11.2 12h9.3M17.3 12v3M20.5 12v3" />
    </>
  ),
  hash: <path d="M9.5 4.5v15M14.5 4.5v15M4.5 9.5h15M4.5 14.5h15" />,
  down: <path d="M12 4.5v13M6.8 12.3 12 17.5l5.2-5.2" />,
}

export function isGlyph(name: string): name is GlyphName {
  return name in PATHS
}

/** @param size in px. 15 sits right beside a board's 0.8rem uppercase title. */
export function Glyph({ name, size = 15 }: { name: GlyphName; size?: number }) {
  return (
    <svg
      className="glyph"
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      focusable="false"
    >
      {PATHS[name]}
    </svg>
  )
}
