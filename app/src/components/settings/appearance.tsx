import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import type { ComponentType } from 'react'

import { cn } from '../../lib/cn'
import { PRESETS, type Scheme, type ThemeChoice, type ThemePreset } from '../../lib/theme'
import { SEGMENT_ITEM, SEGMENT_ITEM_ON, SEGMENT_TRACK } from '../tokens'
import { NOTE, SECTIONS, Section } from './shared'

const SCHEME_OPTIONS: readonly {
  id: Scheme
  label: string
  icon: ComponentType<{ className?: string }>
}[] = [
  { id: 'light', label: 'Light', icon: SunIcon },
  { id: 'dark', label: 'Dark', icon: MoonIcon },
  { id: 'system', label: 'System', icon: MonitorIcon },
]

const FOCUS = 'focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2'

export function Appearance({
  value,
  saving,
  onChange,
}: {
  value: ThemeChoice
  saving: boolean
  onChange: (next: ThemeChoice) => void
}) {
  return (
    // `aria-busy` rather than disabling the controls while a save is in
    // flight: the change has already been applied to the page, so a
    // second click is a new choice, not a duplicate submission.
    <div className={SECTIONS} aria-busy={saving}>
      <Section title="Colour scheme">
        {/* One of three: the segmented control every "one of these" uses. */}
        <div className={cn(SEGMENT_TRACK, 'self-start')}>
          {SCHEME_OPTIONS.map((o) => {
            const Icon = o.icon
            const selected = value.scheme === o.id
            return (
              <button
                key={o.id}
                type="button"
                aria-pressed={selected}
                onClick={() => onChange({ ...value, scheme: o.id })}
                className={cn(
                  SEGMENT_ITEM,
                  'min-w-24 justify-center',
                  FOCUS,
                  selected && SEGMENT_ITEM_ON,
                )}
              >
                <Icon className="size-[15px]" />
                {o.label}
              </button>
            )
          })}
        </div>
        <p className={NOTE}>
          System follows the device this page is open on, resolved before the first paint.
        </p>
      </Section>

      <Section title="Palette">
        <div className="grid gap-3 sm:grid-cols-2">
          {PRESETS.map((p) => (
            <PresetCard
              key={p.id}
              preset={p}
              scheme={value.scheme}
              selected={p.id === value.presetId}
              onSelect={() => onChange({ ...value, presetId: p.id })}
            />
          ))}
        </div>
        <p className={NOTE}>
          A palette sets the accent and leaves the neutrals alone. It applies to this whole control
          plane, including the pages written before any of this existed.
        </p>
      </Section>
    </div>
  )
}

/**
 * A preset's own colours, shown in the preset's own palette.
 *
 * The swatches are inline styles, not utility classes, and have to be:
 * they are the ONE place on the page that must ignore the theme in force
 * and render the theme on offer. Everything else here reads the tokens.
 *
 * The `var(--…)` fallbacks are for a preset that genuinely inherits a
 * token. Every shipped preset states its own accent for exactly that
 * reason — inheriting would make its swatch show the palette being
 * replaced rather than the one being offered.
 */
function PresetCard({
  preset,
  scheme,
  selected,
  onSelect,
}: {
  preset: ThemePreset
  scheme: Scheme
  selected: boolean
  onSelect: () => void
}) {
  const vars = scheme === 'light' ? preset.light : preset.dark
  const swatches = [
    vars.primary ?? 'var(--primary)',
    vars['brand-dim'] ?? 'var(--brand-dim)',
    'var(--success)',
    'var(--warning)',
    'var(--danger)',
  ]

  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'flex cursor-pointer flex-col items-start gap-3 rounded-xl border border-hairline bg-foreground/[0.025] p-4 text-left',
        'shadow-[inset_0_1px_0_var(--hairline-hi)] transition-[background-color,box-shadow] duration-150',
        FOCUS,
        selected ? 'bg-foreground/[0.06] ring-1 ring-foreground/30' : 'hover:bg-foreground/[0.05]',
      )}
    >
      <span className="flex w-full items-center gap-2">
        <span className="text-[0.875rem] [font-weight:560]">{preset.label}</span>
        {selected && <CheckIcon aria-hidden="true" className="ml-auto size-4 text-primary" />}
      </span>
      <span className="flex gap-1.5">
        {swatches.map((c, i) => (
          <span
            // The swatches are a fixed-length list of positions, not a set of
            // identified things — two presets can legitimately show the same
            // colour twice.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={i}
            className="size-5 rounded-full shadow-[inset_0_0_0_1px_color-mix(in_oklch,var(--foreground)_14%,transparent)]"
            style={{ background: c }}
          />
        ))}
      </span>
      <span className="text-[0.75rem] text-muted-foreground leading-snug">{preset.note}</span>
    </button>
  )
}
