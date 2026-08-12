// A LEAF module, deliberately: these are pure line-folding helpers that the
// deployments tab renders with in the browser. They lived in ci.ts until its
// node imports (readSnapshot → node:fs) started riding the client bundle and
// threw "externalized for browser compatibility" on every app page — a client
// component may import from here, never from ci.ts itself.

export type ActivityRow = { ts: string; line: string; source: 'build' | 'deploy' }

export type RolledLine = {
  key: string
  ts: string
  lastTs: string
  line: string
  source: 'build' | 'deploy'
  count: number
}

/**
 * Collapse runs of an identical line into one row with a count.
 *
 * The deploy timer fires every two minutes and logs the same "no change"
 * verdict each time, so six hours of a healthy app is 180 identical lines —
 * a wall that reads as activity and buries the three lines that are not.
 * Folding a run into `no change ×180` says the same thing in one row and
 * leaves the real events visible.
 *
 * Runs only, not a global tally: two "no change" blocks either side of a real
 * deploy are two different facts, and merging them across it would put the
 * events out of order.
 */
export function rollUp(rows: ActivityRow[]): RolledLine[] {
  const out: RolledLine[] = []
  for (const r of rows) {
    const line = shortenDigests(r.line)
    const last = out[out.length - 1]
    if (last && last.line === line && last.source === r.source) {
      last.count++
      last.lastTs = r.ts
      continue
    }
    out.push({
      key: `${r.ts}-${String(out.length)}`,
      ts: r.ts,
      lastTs: r.ts,
      line,
      source: r.source,
      count: 1,
    })
  }
  return out
}

/**
 * `sha256:c20afeca1270849c…f58` → `c20afeca1270`.
 *
 * A full digest is 71 characters and every one of these lines carries one, so
 * untouched they were the whole row and the message they qualify was pushed off
 * the end. Twelve hex characters is what the rest of the page shows and what
 * anyone comparing two of these actually reads.
 */
export function shortenDigests(line: string): string {
  return line.replace(/sha256:([0-9a-f]{12})[0-9a-f]{52}/g, '$1')
}
