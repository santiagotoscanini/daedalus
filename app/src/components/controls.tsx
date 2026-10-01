import { cn } from '../lib/cn'
import { bytes } from '../lib/format'
import { type Tone, toneStyle } from '../lib/tone'
import { Chip, Pulse } from './viz'

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
    <Chip
      tone={toned ? STATE_TONE[state] : 'muted'}
      className={cn(
        'gap-[0.4rem] rounded-full py-[0.15rem] pr-[0.6rem] pl-[0.5rem] text-[0.74rem] font-medium',
        toned
          ? 'border-[color-mix(in_srgb,var(--tone)_35%,transparent)] bg-[color-mix(in_srgb,var(--tone)_8%,transparent)]'
          : 'border-border bg-transparent text-subdued',
      )}
    >
      <StateDot state={state} />
      {label}
    </Chip>
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
        'inline-flex size-[38px] flex-none cursor-pointer items-center justify-center rounded-[9px] border-0 bg-transparent p-0 text-subdued',
        'enabled:hover:bg-raised enabled:hover:text-foreground disabled:cursor-default',
        'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary-dim',
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
  // is the only place it can be read WITHOUT selecting it and without a
  // second row printing the same names. `null` is "cannot tell", drawn grey,
  // and is not the same claim as down.
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
        // would be wider than a phone and scroll the page sideways.
        'inline-flex max-w-full flex-wrap overflow-hidden rounded-[9px] border bg-raised',
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
              ? 'bg-lifted text-foreground shadow-[inset_0_0_0_1px_var(--border)]'
              : 'text-subdued enabled:hover:text-foreground',
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
