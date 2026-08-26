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
  | 'claude'
  | 'menu'
  | 'close'
  | 'chevron'
  // The app rail's sections (routes/apps.$name.tsx APP_TABS) — same rule as
  // the categories: the icon name IS the tab id, nothing to keep in sync.
  | 'overview'
  | 'deployments'
  | 'database'
  | 'vpn'
  | 'access'
  | 'settings'
  | 'secrets'
  | 'logs'

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

  // The one FILLED icon in the set, and the only one not drawn here:
  // Anthropic's own mark, the same path public/icon-claude.svg carries.
  //
  // The rail's real invariant is monochrome-and-currentColor, not
  // stroke-width-1.6 — and a brand mark redrawn as an outline is both a
  // worse icon and still not the logo. So this one opts out of the stroke
  // and fills instead; `fill`/`stroke` here override the <svg>'s own.
  claude: (
    <path
      d="m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"
      fill="currentColor"
      stroke="none"
    />
  ),

  // A dashboard split: the hero row over the board grid.
  overview: (
    <>
      <rect x="3.5" y="3.5" width="17" height="17" rx="2.2" />
      <path d="M3.5 9.8h17M10.2 9.8v10.7" />
    </>
  ),
  // Layers: one image on top of the last.
  deployments: (
    <>
      <path d="M12 3.6 20.6 8 12 12.4 3.4 8Z" />
      <path d="m3.4 12.4 8.6 4.4 8.6-4.4" />
      <path d="m3.4 16.6 8.6 4.4 8.6-4.4" />
    </>
  ),
  database: (
    <>
      <ellipse cx="12" cy="5.6" rx="8" ry="2.7" />
      <path d="M4 5.6v12.8c0 1.5 3.6 2.7 8 2.7s8-1.2 8-2.7V5.6" />
      <path d="M4 12c0 1.5 3.6 2.7 8 2.7s8-1.2 8-2.7" />
    </>
  ),
  // A shield: the tunnel is worn, not configured, from this side.
  vpn: (
    <>
      <path d="M12 3.4c2.5 1.5 5 2.3 7.3 2.5v6.2c0 4.2-3 7.1-7.3 8.5-4.3-1.4-7.3-4.3-7.3-8.5V5.9C7 5.7 9.5 4.9 12 3.4Z" />
      <path d="m9.4 11.9 1.9 1.9 3.4-3.6" />
    </>
  ),
  // A key: who gets in.
  access: (
    <>
      <circle cx="8.4" cy="15.6" r="4.6" />
      <path d="m11.7 12.3 8.4-8.4M16.4 7.6l2.8 2.8" />
    </>
  ),
  // Sliders, not a gear: a gear at 1.6 stroke and 19px is a blob.
  settings: (
    <>
      <path d="M4 7h4.1M11.9 7H20M4 12h8.6M16.4 12H20M4 17h2.6M10.4 17H20" />
      <circle cx="10" cy="7" r="1.9" />
      <circle cx="14.5" cy="12" r="1.9" />
      <circle cx="8.5" cy="17" r="1.9" />
    </>
  ),
  secrets: (
    <>
      <rect x="4.8" y="10.6" width="14.4" height="9.6" rx="2" />
      <path d="M8.2 10.6V7.7a3.8 3.8 0 0 1 7.6 0v2.9" />
    </>
  ),
  // A terminal: where a log is read.
  logs: (
    <>
      <rect x="3.2" y="4.4" width="17.6" height="15.2" rx="2.2" />
      <path d="m7 9.4 3 2.7-3 2.7M12.8 15h4.4" />
    </>
  ),

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
