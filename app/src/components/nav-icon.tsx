// The rail's icons.
//
// Drawn rather than typed. The rail used Unicode glyphs — ▦ ◈ ▶ ⌂ ⛶ ⇄ ◔ ◎ —
// and they come from whatever font the browser has for each codepoint, so they
// arrived at different weights, different optical sizes and different vertical
// alignments. A solid black triangle sat beside a hairline diamond in a column
// that is supposed to read as one set. These are one viewBox, one stroke width
// and one colour, which is the only way eight icons look like eight icons.
//
// `currentColor` throughout: the rail already states rest/hover/active in the
// text colour, and an icon that inherits it needs no rules of its own.

/**
 * Icon names, which are the category ids plus the shell's own controls.
 *
 * There is deliberately no `icon` field on CategorySpec. The name of a
 * category's icon was always its id spelled a second way, and the second
 * spelling is the one that goes stale.
 */
export type NavIconName =
  | 'apps'
  | 'ai'
  | 'media'
  | 'home'
  | 'gaming'
  | 'network'
  | 'system'
  | 'monitoring'
  | 'menu'
  | 'close'
  | 'chevron'

const PATHS: Record<NavIconName, React.ReactNode> = {
  // Four tiles: the app list.
  apps: (
    <>
      <rect x="3.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="3.5" width="7" height="7" rx="2" />
      <rect x="3.5" y="13.5" width="7" height="7" rx="2" />
      <rect x="13.5" y="13.5" width="7" height="7" rx="2" />
    </>
  ),
  // A spark, the one shape that reads as "model" at 18px.
  ai: (
    <>
      <path d="M10 3.2c0 3.75 3.05 6.8 6.8 6.8-3.75 0-6.8 3.05-6.8 6.8 0-3.75-3.05-6.8-6.8-6.8 3.75 0 6.8-3.05 6.8-6.8Z" />
      <path d="M17.6 14.4c0 1.44 1.16 2.6 2.6 2.6-1.44 0-2.6 1.16-2.6 2.6 0-1.44-1.16-2.6-2.6-2.6 1.44 0 2.6-1.16 2.6-2.6Z" />
    </>
  ),
  // Play: both libraries under it end in something being watched or read.
  media: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M10.15 8.75 15.7 12l-5.55 3.25Z" />
    </>
  ),
  home: (
    <>
      <path d="M3.6 10.5 12 3.8l8.4 6.7v8.3a1.7 1.7 0 0 1-1.7 1.7H5.3a1.7 1.7 0 0 1-1.7-1.7Z" />
      <path d="M9.5 20.5v-5.9h5v5.9" />
    </>
  ),
  gaming: (
    <>
      <path d="M7.9 8.4h8.2a4.9 4.9 0 0 1 4.83 4.05l.63 3.6a2.36 2.36 0 0 1-4.35 1.6l-1.2-2.05H7.99l-1.2 2.05a2.36 2.36 0 0 1-4.35-1.6l.63-3.6A4.9 4.9 0 0 1 7.9 8.4Z" />
      {/* Kept sparse deliberately: at the 19px the rail draws these, a d-pad
          and two face buttons at real proportions merge into one smudge. */}
      <path d="M6.7 11.75v2.2M5.6 12.85h2.2" />
      <path d="M15.6 12h.01M18.2 14.4h.01" />
    </>
  ),
  // A globe: everything on this page is about reaching, or being reached.
  network: (
    <>
      <circle cx="12" cy="12" r="8.6" />
      <path d="M3.4 12h17.2" />
      <path d="M12 3.4a13.2 13.2 0 0 1 0 17.2 13.2 13.2 0 0 1 0-17.2Z" />
    </>
  ),
  // Two stacked units: the machine, not the software on it.
  system: (
    <>
      <rect x="3.2" y="4.2" width="17.6" height="6.3" rx="1.9" />
      <rect x="3.2" y="13.5" width="17.6" height="6.3" rx="1.9" />
      <path d="M6.9 7.35h.01M6.9 16.65h.01" />
    </>
  ),
  // A trace: the only category whose subject is a line moving.
  monitoring: <path d="M2.9 12.7h4.3l2.45-6.4 3.7 11.5 2.35-5.1h5.4" />,

  menu: <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6.2 6.2l11.6 11.6M17.8 6.2 6.2 17.8" />,
  // Points left; the rail rotates it when collapsed.
  chevron: <path d="M14.4 7.4 9.8 12l4.6 4.6" />,
}

/**
 * @param size in px. The rail uses 19 for a nav row and 17 for its controls —
 *   an icon that is doing the same job as a label wants to be a shade smaller
 *   than one that is the whole button.
 */
export function NavIcon({ name, size = 19 }: { name: NavIconName; size?: number }) {
  return (
    <svg
      className="nav-icon"
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
