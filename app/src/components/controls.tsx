import type { ReactNode } from 'react'
import { cn } from '../lib/cn'
import { bytes } from '../lib/format'
import { type Tone, toneStyle } from '../lib/tone'

import { Pulse } from './viz'

export type AppState = 'running' | 'attention' | 'stopped' | 'unknown'

// The four states as the six-verdict vocabulary the rest of the dashboard
// speaks, so the dot and the pill tint from one `--tone` rather than from a
// class per state.
const STATE_TONE: Record<AppState, Tone> = {
  running: 'ok',
  attention: 'bad',
  stopped: 'muted',
  unknown: 'muted',
}

/** Whether the state is a verdict at all. `stopped` and `unknown` are not:
    they get the resting grey, with no ring and no tinted pill. */
function isVerdict(state: AppState): boolean {
  return state === 'running' || state === 'attention'
}

export function StateDot({
  state,
  label = state,
  title = label,
}: {
  state: AppState
  /** What the dot reads as; the state name unless the caller knows better. */
  label?: string
  /** The explanation on hover; the label unless there is more to say. */
  title?: string
}) {
  // role="img": a bare <span> has no role, so assistive tech would drop the
  // aria-label; as an image the dot reads as its state name.
  return (
    <span
      className={cn(
        'inline-block size-[0.56rem] flex-none rounded-full bg-(--tone)',
        isVerdict(state) && 'shadow-[0_0_0_3px_color-mix(in_srgb,var(--tone)_15%,transparent)]',
      )}
      style={toneStyle(STATE_TONE[state])}
      role="img"
      aria-label={label}
      title={title}
    />
  )
}

/**
 * An app's own icon, or a monogram when it does not serve one.
 *
 * `hasIcon` is resolved on the server and passed in rather than discovered
 * here with an `onError` handler: these pages are server-rendered, and an
 * <img> that 404s would flash a broken-image glyph before any client code
 * could swap it out. The monogram is then the first thing drawn, not a repair.
 *
 * The monogram's hue is derived from the name, so an app without an icon still
 * gets a stable colour to recognise it by — and gets it without anyone typing
 * one in.
 */
export function AppIcon({
  name,
  hasIcon,
  size = 22,
}: {
  name: string
  hasIcon: boolean
  size?: number
}) {
  if (!hasIcon) {
    return (
      <span
        // The three hsl() reads are the one place a colour is computed rather
        // than named: the hue is per-instance, so it cannot be a theme token.
        className="grid flex-none place-items-center rounded-[5px] leading-none [font-weight:650] text-[0.72em] text-[hsl(var(--mono-hue)_55%_72%)] bg-[hsl(var(--mono-hue)_45%_12%)] shadow-[inset_0_0_0_1px_hsl(var(--mono-hue)_40%_22%)]"
        style={{ width: size, height: size, ['--mono-hue' as string]: String(hue(name)) }}
        aria-hidden="true"
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    // `contain` rather than `cover` so a non-square icon is shown whole instead
    // of cropped — these are logos, and a cropped logo is a different logo.
    <img
      className="block flex-none rounded-[5px] object-contain"
      src={`/api/app-icon/${encodeURIComponent(name)}`}
      alt=""
      width={size}
      height={size}
      loading="lazy"
      decoding="async"
    />
  )
}

/** A stable hue per name. Any spread over the wheel will do; this one is cheap. */
function hue(name: string): number {
  let h = 0
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) % 360
  return h
}

export function StatePill({ state }: { state: AppState }) {
  const label =
    state === 'running'
      ? 'running'
      : state === 'attention'
        ? 'needs attention'
        : state === 'stopped'
          ? 'stopped'
          : 'unknown'
  const toned = isVerdict(state)
  return (
    <span
      className={cn(
        'inline-flex items-center gap-[0.4rem] rounded-full border py-[0.15rem] pr-[0.6rem] pl-[0.5rem] text-[0.74rem] font-medium',
        toned
          ? 'border-[color-mix(in_srgb,var(--tone)_35%,transparent)] bg-[color-mix(in_srgb,var(--tone)_8%,transparent)] text-(--tone)'
          : 'text-(--text-muted)',
      )}
      style={toned ? toneStyle(STATE_TONE[state]) : undefined}
    >
      <StateDot state={state} />
      {label}
    </span>
  )
}

export function Bytes({ value }: { value: number | null }) {
  return <>{bytes(value)}</>
}

/**
 * Ask a memoized upstream again.
 *
 * Two reads behind /apps/new are cached server-side — the repository listing
 * and a repo's preflight — which is what keeps a keystroke-hot form off
 * GitHub's hourly budget, and is also why a repo created a minute ago stays
 * invisible until the TTL lapses. This is the way past that, so the in-flight
 * state has to show: a refresh that looks like nothing happened is a refresh
 * pressed twice.
 */
export function RefreshButton({
  busy,
  label,
  onClick,
}: {
  busy: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={cn(
        'inline-flex size-[38px] flex-none cursor-pointer items-center justify-center rounded-[9px] border-0 bg-transparent p-0 text-(--text-muted)',
        'enabled:hover:bg-(--panel-2) enabled:hover:text-foreground disabled:cursor-default',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand-dim)',
        // Right-aligned and smaller inside a section heading, which is a
        // baseline-aligned flex row — hence the self-alignment, since a 30px
        // button has no useful baseline.
        '[h2>&]:ml-auto [h2>&]:size-[30px] [h2>&]:self-center [h2>&]:text-[0.95rem]',
      )}
      title={label}
      aria-label={label}
      aria-busy={busy}
      disabled={busy}
      onClick={onClick}
    >
      {/* The glyph spins, not the button: rotating the button would carry its
          hover fill and focus ring around with it. Reduced motion keeps the
          disabled state, which is the part that says "in flight". */}
      <span
        aria-hidden="true"
        className={
          busy
            ? 'inline-block animate-spin [animation-duration:0.9s] motion-reduce:animate-none'
            : undefined
        }
      >
        ↻
      </span>
    </button>
  )
}

// One choice among a few, so the group is a radiogroup to assistive tech.
// The options stay plain <button>s, each tabbable on its own — the roving
// tabindex and arrow keys of a native radio group are not rebuilt here,
// because Tab reaching every option is more presses, not wrong.
export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
  label,
}: {
  value: T
  onChange: (v: T) => void
  /** Names the group for assistive tech — most of these pickers have no
      visible label element to point at. */
  label?: string
  // Per-option `disabled` + `reason` exist so a choice the platform would
  // reject can be greyed out with an explanation, instead of being accepted,
  // written to the database and then failing at Apply with a build error.
  //
  // `dot` puts each option's own health on the button that selects it, which
  // is the only place it can be read WITHOUT selecting it — the alternative
  // was a second row of the same names carrying the same dots, and a name
  // printed twice is a name the reader has to reconcile. `null` is "cannot
  // tell", drawn grey, and is not the same claim as down.
  options: {
    value: T
    label: string
    icon?: string
    dot?: Tone | null
    disabled?: boolean
    reason?: string
  }[]
  disabled?: boolean
}) {
  return (
    <div
      role="radiogroup"
      aria-label={label}
      className={cn(
        // A pill of buttons that has to be allowed to become two rows.
        // `inline-flex` with no wrap is a single unbreakable box as wide as
        // its labels, so a control with five options — or three long ones —
        // was simply wider than a phone, and the page scrolled sideways.
        'inline-flex max-w-full flex-wrap overflow-hidden rounded-[9px] border bg-(--panel-2)',
      )}
    >
      {options.map((o) => (
        // biome-ignore lint/a11y/useSemanticElements: a native <input type="radio"> would trade the button markup for a hidden-input-plus-label rebuild; the role carries the same semantics on the element that already looks and acts the part.
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={o.value === value}
          disabled={disabled ?? o.disabled}
          aria-disabled={(disabled ?? o.disabled) === true ? true : undefined}
          title={o.reason}
          className={cn(
            'inline-flex cursor-pointer items-center gap-[0.35rem] border-0 bg-transparent px-[0.85rem] py-[0.42rem] text-[0.83rem]',
            o.value === value
              ? 'bg-(--raise) text-foreground shadow-[inset_0_0_0_1px_var(--border)]'
              : 'text-(--text-muted) enabled:hover:text-foreground',
            (disabled ?? o.disabled) === true && 'cursor-not-allowed opacity-55',
          )}
          onClick={() => {
            onChange(o.value)
          }}
        >
          {o.icon && <span aria-hidden="true">{o.icon}</span>}
          {'dot' in o && <Pulse on={o.dot === 'ok'} tone={o.dot ?? 'muted'} />}
          {o.label}
        </button>
      ))}
    </div>
  )
}

/**
 * A resource ceiling.
 *
 * The minimum position means *uncapped*, not zero — a zero-core or zero-byte
 * container is not a thing you can ask for, so the bottom of the range is free
 * to carry the more useful meaning. `onChange` emits null there.
 */
export function Slider({
  label,
  hint,
  value,
  min,
  max,
  step,
  format,
  disabled,
  onChange,
}: {
  label: string
  hint?: string
  value: number | null
  min: number
  max: number
  step: number
  format: (v: number) => ReactNode
  disabled?: boolean
  onChange: (v: number | null) => void
}) {
  // Below `min` so the thumb parks left of every real value; the input's own
  // min is this sentinel, which is what lets "uncapped" be a reachable
  // position rather than a checkbox next to the slider.
  const OFF = min - step
  return (
    <div
      className={cn(
        // Stacked by default — label and value on one line, the track full
        // width underneath — and only laid out in three columns when the board
        // it sits in is wide enough for the label column to hold its hint
        // without wrapping one word per line. `board` is the query container
        // declared on `.board-body`, so the shape follows the panel's width
        // rather than the viewport's.
        'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-[0.4rem] border-b border-b-(color:--border-soft) py-[0.7rem] last-of-type:border-b-0',
        '@min-[34rem]/board:grid-cols-[minmax(15rem,1fr)_minmax(10rem,1.5fr)_6.5rem] @min-[34rem]/board:gap-x-6 @min-[34rem]/board:gap-y-2',
        disabled === true && 'opacity-50',
      )}
    >
      <div className="min-w-0 text-[0.9rem]">
        {label}
        {hint !== undefined && (
          <small className="mt-[0.15rem] block text-[0.76rem] leading-[1.4] text-muted-foreground">
            {hint}
          </small>
        )}
      </div>
      <input
        type="range"
        className={cn(
          // Full width under the label in the stacked shape; its own column
          // once the container query has room for one.
          'col-span-full mt-[0.3rem] w-full cursor-pointer bg-transparent [-webkit-appearance:none] [appearance:none] disabled:cursor-not-allowed',
          '@min-[34rem]/board:col-auto @min-[34rem]/board:mt-0',
          // Track and thumb need both vendor spellings. Each utility emits its
          // own rule, so an engine that does not know one selector drops only
          // that rule rather than the whole declaration block.
          '[&::-webkit-slider-runnable-track]:h-[3px] [&::-webkit-slider-runnable-track]:rounded-[2px] [&::-webkit-slider-runnable-track]:bg-border',
          '[&::-moz-range-track]:h-[3px] [&::-moz-range-track]:rounded-[2px] [&::-moz-range-track]:bg-border',
          '[&::-webkit-slider-thumb]:[-webkit-appearance:none] [&::-webkit-slider-thumb]:[appearance:none] [&::-webkit-slider-thumb]:mt-[-6px] [&::-webkit-slider-thumb]:size-[15px] [&::-webkit-slider-thumb]:rounded-full [&::-webkit-slider-thumb]:border-[3px] [&::-webkit-slider-thumb]:border-card',
          '[&::-moz-range-thumb]:size-[15px] [&::-moz-range-thumb]:rounded-full [&::-moz-range-thumb]:border-[3px] [&::-moz-range-thumb]:border-card',
          // At the sentinel the control is OFF, not at zero. Drawn as a solid
          // thumb on a full track it would read as a slider that failed to
          // load its value rather than as a ceiling nobody set.
          value === null
            ? '[&::-webkit-slider-thumb]:bg-card [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_var(--dim)] [&::-moz-range-thumb]:bg-card [&::-moz-range-thumb]:shadow-[0_0_0_1px_var(--dim)]'
            : '[&::-webkit-slider-thumb]:bg-primary [&::-webkit-slider-thumb]:shadow-[0_0_0_1px_var(--brand)] [&::-moz-range-thumb]:bg-primary [&::-moz-range-thumb]:shadow-[0_0_0_1px_var(--brand)]',
        )}
        min={OFF}
        max={max}
        step={step}
        value={value ?? OFF}
        disabled={disabled}
        aria-label={label}
        onChange={(e) => {
          const v = Number(e.target.value)
          onChange(v <= OFF ? null : v)
        }}
      />
      <div className="min-w-[5.5rem] text-right font-mono text-base whitespace-nowrap text-primary [&_small]:ml-[0.2rem] [&_small]:text-[0.72rem] [&_small]:text-muted-foreground">
        {value === null ? (
          <span className="text-[0.86rem] text-muted-foreground">uncapped</span>
        ) : (
          format(value)
        )}
      </div>
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
  disabled?: boolean
}) {
  return (
    <label
      className={cn(
        'flex cursor-pointer items-start gap-[0.7rem] border-b border-b-(color:--border-soft) py-[0.55rem] last:border-b-0',
        disabled === true && 'cursor-not-allowed opacity-50',
      )}
    >
      <input
        type="checkbox"
        className="peer absolute size-0 opacity-0"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.checked)
        }}
      />
      {/* The checkbox is visually hidden, so the focus ring has to be drawn on
          the track that stands in for it. */}
      <span
        className={cn(
          'relative mt-[0.15rem] h-5 w-[34px] flex-none rounded-full border bg-(--raise) transition-[background] duration-[120ms]',
          "after:absolute after:top-[2px] after:left-[2px] after:size-[14px] after:rounded-full after:bg-(--text-muted) after:transition-[transform,background] after:duration-[120ms] after:content-['']",
          'peer-checked:border-(--brand-dim) peer-checked:bg-[color-mix(in_srgb,var(--brand)_30%,transparent)]',
          'peer-checked:after:translate-x-[14px] peer-checked:after:bg-primary',
          'peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-(--brand-dim)',
        )}
        aria-hidden="true"
      />
      <span className="text-[0.9rem]">
        {label}
        {hint && (
          <small className="block text-[0.76rem] leading-[1.4] text-muted-foreground">{hint}</small>
        )}
      </span>
    </label>
  )
}
