import { CheckIcon, MonitorIcon, MoonIcon, SunIcon } from 'lucide-react'
import type { ComponentType } from 'react'

import { cn } from '../../lib/cn'
import { PRESETS, type Scheme, type ThemeChoice, type ThemePreset } from '../../lib/theme'
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '../ui/card'

const SCHEME_OPTIONS: readonly {
  id: Scheme
  label: string
  icon: ComponentType<{ className?: string }>
}[] = [
  { id: 'light', label: 'Light', icon: SunIcon },
  { id: 'dark', label: 'Dark', icon: MoonIcon },
  { id: 'system', label: 'System', icon: MonitorIcon },
]

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
    <div className="flex flex-col gap-6" aria-busy={saving}>
      <Card>
        <CardHeader>
          <CardTitle>Colour scheme</CardTitle>
          <CardDescription>
            System follows the device this page is open on, resolved before the first paint.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
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
                    'flex min-w-28 cursor-pointer items-center gap-2 rounded-lg border px-4 py-2.5',
                    'text-sm transition-colors',
                    'focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
                    selected
                      ? 'border-primary bg-primary/10 text-foreground'
                      : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
                  )}
                >
                  <Icon className="size-4" />
                  {o.label}
                </button>
              )
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Palette</CardTitle>
          <CardDescription>
            A palette sets the accent and leaves the neutrals alone. It applies to this whole
            control plane, including the pages written before any of this existed.
          </CardDescription>
        </CardHeader>
        <CardContent>
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
        </CardContent>
      </Card>
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
        'flex cursor-pointer flex-col items-start gap-3 rounded-lg border p-4 text-left',
        'transition-colors focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2',
        selected ? 'border-primary bg-primary/5' : 'border-border hover:bg-accent/50',
      )}
    >
      <span className="flex w-full items-center gap-2">
        <span className="font-medium text-sm">{preset.label}</span>
        {selected && <CheckIcon className="ml-auto size-4 text-primary" />}
      </span>
      <span className="flex gap-1.5">
        {swatches.map((c, i) => (
          <span
            // The swatches are a fixed-length list of positions, not a set of
            // identified things — two presets can legitimately show the same
            // colour twice.
            // biome-ignore lint/suspicious/noArrayIndexKey: see above
            key={i}
            className="size-5 rounded-full border border-border/60"
            style={{ background: c }}
          />
        ))}
      </span>
      <span className="text-muted-foreground text-xs leading-snug">{preset.note}</span>
    </button>
  )
}
