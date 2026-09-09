/**
 * Themes: what one is, which ones ship, and how one becomes CSS.
 *
 * A preset is a map from shadcn token name to colour, for each of the two
 * schemes. That shape is not arbitrary — it is what `components.json`
 * `cssVars` and every tweakcn export already use, so a preset copied from
 * outside is a paste rather than a translation, and the reverse is true
 * too.
 *
 * Tokens NOT listed by a preset fall through to the defaults in theme.css.
 * That is what makes a preset small: it names the dozen colours that give
 * a theme its character and inherits the rest.
 */

export const SCHEMES = ['light', 'dark', 'system'] as const
export type Scheme = (typeof SCHEMES)[number]

export function isScheme(v: unknown): v is Scheme {
  return typeof v === 'string' && (SCHEMES as readonly string[]).includes(v)
}

/** Token name (without the leading `--`) → CSS colour value. */
export type ThemeVars = Record<string, string>

export type ThemePreset = {
  id: string
  label: string
  /** One line the Appearance page shows under the name. */
  note: string
  light: ThemeVars
  dark: ThemeVars
}

/**
 * The token names a preset is allowed to set.
 *
 * An allowlist rather than "whatever the preset contains", because these
 * values are interpolated into a `<style>` element in the document head.
 * A preset arriving from anywhere but this file — a paste into the
 * Appearance page, a row read back out of Postgres — is untrusted input,
 * and an unfiltered key or value is a CSS injection with a `</style>` in
 * it. `themeCss` below filters on both.
 */
export const THEMEABLE = [
  'background',
  'foreground',
  'card',
  'card-foreground',
  'popover',
  'popover-foreground',
  'primary',
  'primary-foreground',
  'secondary',
  'secondary-foreground',
  'muted',
  'muted-foreground',
  'accent',
  'accent-foreground',
  'destructive',
  'destructive-foreground',
  'success',
  'warning',
  'danger',
  'info',
  'border',
  'input',
  'ring',
  'chart-1',
  'chart-2',
  'chart-3',
  'chart-4',
  'chart-5',
  'sidebar',
  'sidebar-foreground',
  'sidebar-primary',
  'sidebar-primary-foreground',
  'sidebar-accent',
  'sidebar-accent-foreground',
  'sidebar-border',
  'sidebar-ring',
  'radius',
  // The legacy vocabulary. styles.css aliases most of these onto the
  // shadcn tokens above, so a preset normally leaves them alone — but the
  // surfaces that have no shadcn equivalent (`panel-2`, `raise`,
  // `border-soft`) have to be settable or a light preset cannot get its
  // raised layers right.
  'panel-2',
  'raise',
  'border-soft',
  'text-muted',
  'brand-dim',
] as const

const THEMEABLE_SET: ReadonlySet<string> = new Set(THEMEABLE)

/**
 * A CSS colour, length or keyword — and nothing that could close the
 * `<style>` element or start a new declaration. Deliberately narrower than
 * CSS allows: everything a theme needs fits, and `url(`, quotes, braces,
 * semicolons and angle brackets do not.
 */
const SAFE_VALUE = /^[a-zA-Z0-9\s.,%#()/_-]{1,120}$/

/** The one preset that must never fail to load: what the app shipped with. */
export const DEFAULT_PRESET_ID = 'terracotta'

export const PRESETS: readonly ThemePreset[] = [
  {
    id: 'terracotta',
    label: 'Terracotta',
    note: "daedalus's own palette — warm accent on true neutral.",
    // Restates the defaults in theme.css rather than inheriting them with an
    // empty map. An empty preset would be correct as a stylesheet — there is
    // nothing to override — but its swatches would then render in whatever
    // palette is currently in force, so the default would advertise the
    // colours of whichever preset you were about to replace.
    light: {
      primary: 'oklch(0.6881 0.1381 37.27)',
      'primary-foreground': 'oklch(0.1448 0 0)',
      ring: 'oklch(0.6881 0.1381 37.27)',
      'chart-1': 'oklch(0.6881 0.1381 37.27)',
      'sidebar-primary': 'oklch(0.6881 0.1381 37.27)',
      'sidebar-primary-foreground': 'oklch(0.1448 0 0)',
      'brand-dim': 'oklch(0.5698 0.134 36.78)',
    },
    dark: {
      primary: 'oklch(0.6881 0.1381 37.27)',
      'primary-foreground': 'oklch(0.1448 0 0)',
      ring: 'oklch(0.6881 0.1381 37.27)',
      'chart-1': 'oklch(0.6881 0.1381 37.27)',
      'sidebar-primary': 'oklch(0.6881 0.1381 37.27)',
      'sidebar-primary-foreground': 'oklch(0.1448 0 0)',
      'brand-dim': 'oklch(0.5698 0.134 36.78)',
    },
  },
  {
    id: 'graphite',
    label: 'Graphite',
    note: 'The same neutrals with the accent dropped to a cool grey.',
    light: {
      primary: 'oklch(0.45 0.01 250)',
      'primary-foreground': 'oklch(0.985 0 0)',
      ring: 'oklch(0.45 0.01 250)',
      'chart-1': 'oklch(0.45 0.01 250)',
      'sidebar-primary': 'oklch(0.45 0.01 250)',
      'sidebar-primary-foreground': 'oklch(0.985 0 0)',
      'brand-dim': 'oklch(0.38 0.01 250)',
    },
    dark: {
      primary: 'oklch(0.72 0.02 250)',
      'primary-foreground': 'oklch(0.1448 0 0)',
      ring: 'oklch(0.72 0.02 250)',
      'chart-1': 'oklch(0.72 0.02 250)',
      'sidebar-primary': 'oklch(0.72 0.02 250)',
      'sidebar-primary-foreground': 'oklch(0.1448 0 0)',
      'brand-dim': 'oklch(0.58 0.02 250)',
    },
  },
  {
    id: 'cobalt',
    label: 'Cobalt',
    note: 'A blue accent, for a box that is not this one.',
    light: {
      primary: 'oklch(0.52 0.19 258)',
      'primary-foreground': 'oklch(0.985 0 0)',
      ring: 'oklch(0.52 0.19 258)',
      'chart-1': 'oklch(0.52 0.19 258)',
      'sidebar-primary': 'oklch(0.52 0.19 258)',
      'sidebar-primary-foreground': 'oklch(0.985 0 0)',
      'brand-dim': 'oklch(0.44 0.17 258)',
    },
    dark: {
      primary: 'oklch(0.65 0.17 258)',
      'primary-foreground': 'oklch(0.1448 0 0)',
      ring: 'oklch(0.65 0.17 258)',
      'chart-1': 'oklch(0.65 0.17 258)',
      'sidebar-primary': 'oklch(0.65 0.17 258)',
      'sidebar-primary-foreground': 'oklch(0.1448 0 0)',
      'brand-dim': 'oklch(0.54 0.15 258)',
    },
  },
  {
    id: 'moss',
    label: 'Moss',
    note: 'Green accent. Shares a hue with the healthy state — check a board before keeping it.',
    light: {
      primary: 'oklch(0.5 0.11 152)',
      'primary-foreground': 'oklch(0.985 0 0)',
      ring: 'oklch(0.5 0.11 152)',
      'chart-1': 'oklch(0.5 0.11 152)',
      'sidebar-primary': 'oklch(0.5 0.11 152)',
      'sidebar-primary-foreground': 'oklch(0.985 0 0)',
      'brand-dim': 'oklch(0.42 0.1 152)',
    },
    dark: {
      primary: 'oklch(0.72 0.11 152)',
      'primary-foreground': 'oklch(0.1448 0 0)',
      ring: 'oklch(0.72 0.11 152)',
      'chart-1': 'oklch(0.72 0.11 152)',
      'sidebar-primary': 'oklch(0.72 0.11 152)',
      'sidebar-primary-foreground': 'oklch(0.1448 0 0)',
      'brand-dim': 'oklch(0.6 0.1 152)',
    },
  },
]

export function presetById(id: string | undefined): ThemePreset {
  const found = PRESETS.find((p) => p.id === id)
  if (found) return found
  const fallback = PRESETS.find((p) => p.id === DEFAULT_PRESET_ID)
  // PRESETS is a non-empty literal, but noUncheckedIndexedAccess does not
  // know that and the theme must not be the thing that throws.
  if (fallback) return fallback
  return { id: DEFAULT_PRESET_ID, label: 'Default', note: '', light: {}, dark: {} }
}

export type ThemeChoice = {
  presetId: string
  scheme: Scheme
}

export const DEFAULT_THEME: ThemeChoice = {
  presetId: DEFAULT_PRESET_ID,
  scheme: 'dark',
}

export function isThemeChoice(v: unknown): v is ThemeChoice {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return typeof o.presetId === 'string' && isScheme(o.scheme)
}

function block(selector: string, vars: ThemeVars): string {
  const decls = Object.entries(vars)
    .filter(([k, v]) => THEMEABLE_SET.has(k) && SAFE_VALUE.test(v))
    .map(([k, v]) => `--${k}:${v};`)
    .join('')
  return decls === '' ? '' : `${selector}{${decls}}`
}

/**
 * The preset as a stylesheet, for the document head.
 *
 * Rendered server-side into the initial HTML rather than applied by an
 * effect: a preset that arrives after hydration means the first paint is
 * the default palette and the page visibly repaints. Both schemes are
 * emitted every time, because the boot script may resolve `system` to
 * either one before this stylesheet is even parsed.
 */
export function themeCss(preset: ThemePreset): string {
  return (
    block(":root,[data-theme='light']", preset.light) + block("[data-theme='dark']", preset.dark)
  )
}
