export type AppState = 'running' | 'attention' | 'stopped' | 'unknown'

export function StateDot({ state }: { state: AppState }) {
  return <span className={`dot dot-${state}`} aria-label={state} title={state} />
}

/**
 * Requests/min over the last hour. Rendered as an inline SVG path rather than
 * a chart library — it is one polyline and the app already avoids build-time
 * dependencies it does not need.
 *
 * An empty series draws nothing at all rather than a flat line at zero: "no
 * data" and "no traffic" are different claims, and a flat line makes the
 * second one look certain.
 */
export function Sparkline({ values, state }: { values: number[]; state: AppState }) {
  if (values.length < 2) return <span className="spark-empty">no data</span>

  const w = 96
  const h = 26
  const max = Math.max(...values, 0.0001)
  const step = w / (values.length - 1)

  const points = values.map((v, i) => `${(i * step).toFixed(1)},${(h - (v / max) * h).toFixed(1)}`)

  return (
    <svg className={`spark spark-${state}`} width={w} height={h} viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={points.join(' ')} fill="none" strokeWidth="1.5" />
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
