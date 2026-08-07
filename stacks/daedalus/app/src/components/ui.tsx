import type { ReactNode } from 'react'

import { Pulse, type Tone } from './viz'

export type AppState = 'running' | 'attention' | 'stopped' | 'unknown'

export function StateDot({ state }: { state: AppState }) {
  return <span className={`dot dot-${state}`} aria-label={state} title={state} />
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
        className="appicon appicon-mono"
        style={{ width: size, height: size, ['--mono-hue' as string]: String(hue(name)) }}
        aria-hidden="true"
      >
        {name.slice(0, 1).toUpperCase()}
      </span>
    )
  }
  return (
    <img
      className="appicon"
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
    state === 'running' ? 'running'
    : state === 'attention' ? 'needs attention'
    : state === 'stopped' ? 'stopped'
    : 'unknown'
  return (
    <span className={`pill pill-${state}`}>
      <StateDot state={state} />
      {label}
    </span>
  )
}

export function Bytes({ value }: { value: number | null }) {
  if (value === null) return <>—</>
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let v = value
  let u = 0
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024
    u++
  }
  return (
    <>
      {v.toFixed(v >= 10 || u === 0 ? 0 : 1)} {units[u]}
    </>
  )
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  disabled,
}: {
  value: T
  onChange: (v: T) => void
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
    <div className={disabled ? 'segmented disabled' : 'segmented'}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled ?? o.disabled}
          title={o.reason}
          className={o.value === value ? 'active' : ''}
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
      className={[
        'slider',
        disabled === true ? 'disabled' : '',
        // At the sentinel there is no ceiling, so the thumb is drawn hollow
        // rather than as a value the operator chose.
        value === null ? 'slider-off' : '',
      ]
        .filter(Boolean)
        .join(' ')}
    >
      <div className="slider-text">
        {label}
        {hint !== undefined && <small>{hint}</small>}
      </div>
      <input
        type="range"
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
      <div className="slider-value">
        {value === null ? <span className="muted">uncapped</span> : format(value)}
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
    <label className={disabled ? 'toggle disabled' : 'toggle'}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.checked)
        }}
      />
      <span className="track" aria-hidden="true" />
      <span className="toggle-text">
        {label}
        {hint && <small>{hint}</small>}
      </span>
    </label>
  )
}
