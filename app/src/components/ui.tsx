import type { ReactNode } from 'react'

export type AppState = 'running' | 'attention' | 'stopped' | 'unknown'

export function StateDot({ state }: { state: AppState }) {
  return <span className={`dot dot-${state}`} aria-label={state} title={state} />
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

/**
 * Requests/min over the last hour, as a filled area.
 *
 * Inline SVG rather than a chart library: it is one path, and the container's
 * whole design is to start fast and reload faster — a charting dependency
 * would be the largest thing in node_modules by an order of magnitude.
 *
 * An empty series renders "no data", never a flat line at zero. "Nothing is
 * being recorded" and "there is no traffic" are different claims and a zero
 * line asserts the second one.
 */
export function AreaChart({
  values,
  state = 'running',
  width = 300,
  height = 64,
}: {
  values: number[]
  state?: AppState
  width?: number
  height?: number
}) {
  if (values.length < 2) return <p className="chart-empty">no data</p>

  const max = Math.max(...values, 0.0001)
  const step = width / (values.length - 1)
  const pts = values.map((v, i) => [i * step, height - (v / max) * (height - 4) - 2] as const)

  const line = pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' ')
  const area = `M0,${String(height)} L${line.split(' ').join(' L')} L${String(width)},${String(height)} Z`
  const id = `grad-${state}`

  return (
    <svg
      className={`chart chart-${state}`}
      viewBox={`0 0 ${String(width)} ${String(height)}`}
      preserveAspectRatio="none"
      aria-hidden="true"
    >
      <defs>
        <linearGradient id={id} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" className="grad-top" />
          <stop offset="100%" className="grad-bottom" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} stroke="none" />
      <polyline points={line} fill="none" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
    </svg>
  )
}

export function Sparkline({ values, state }: { values: number[]; state: AppState }) {
  if (values.length < 2) return <span className="spark-empty">no data</span>

  const w = 88
  const h = 24
  const max = Math.max(...values, 0.0001)
  const step = w / (values.length - 1)
  const pts = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)

  return (
    <svg className={`spark spark-${state}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts.join(' ')} fill="none" strokeWidth="1.5" />
    </svg>
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

export function Metric({
  label,
  value,
  unit,
  children,
}: {
  label: string
  value: ReactNode
  unit?: string
  children?: ReactNode
}) {
  return (
    <section className="metric">
      <h3>{label}</h3>
      <p className="metric-value">
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
      </p>
      {children}
    </section>
  )
}

export function Panel({
  title,
  action,
  children,
}: {
  title: string
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className="panel">
      <header>
        <h3>{title}</h3>
        {action}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  )
}

export function Row({ k, v, mono }: { k: string; v: ReactNode; mono?: boolean }) {
  return (
    <div className="row">
      <span className="row-k">{k}</span>
      <span className={mono ? 'row-v mono' : 'row-v'}>{v}</span>
    </div>
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
  options: { value: T; label: string; icon?: string }[]
  disabled?: boolean
}) {
  return (
    <div className={disabled ? 'segmented disabled' : 'segmented'}>
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          disabled={disabled}
          className={o.value === value ? 'active' : ''}
          onClick={() => {
            onChange(o.value)
          }}
        >
          {o.icon && <span aria-hidden="true">{o.icon}</span>}
          {o.label}
        </button>
      ))}
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
