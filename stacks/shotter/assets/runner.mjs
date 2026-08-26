// The in-container run harness: everything between "a driver script" and "a
// run directory an agent can read".
//
// THE OUTPUT CONTRACT IS THE PRODUCT. Playwright already captures more than
// this ever will (traces, video, HAR) — but its output is a GUI trace viewer,
// which is exactly what a headless box cannot show and an agent cannot read.
// This harness emits the agent-shaped version and nothing else:
//
//   /lab/runs/<id>/
//     NN-<name>.png    viewport-sized slices — never one tall smear; a
//                      9000px PNG downscales into unreadability inside an
//                      agent's context, which defeats the whole point
//     events.json      console messages, page errors, failed requests, ≥400s
//     summary.json     one screen of truth: ok, counts, shots, pages, error
//     log.txt          the driver's own narration
//   /lab/history.jsonl one line per run, append-only (stats + daedalus feed)
//   /lab/stats.json    totals + last run
//
// EVENTS OUTRANK PIXELS. The canonical example is iris's Tailwind
// `source(none)` trap: the server links a stylesheet that was never
// published, every first paint 404s, hydration papers over it — and a
// screenshot taken after hydration looks perfect. The 404 is in events.json.
// A green screenshot with a red events.json is a broken page.
//
// Drivers receive everything they need and import NOTHING (there is no
// node_modules where they run):
//
//   export default async ({ page, context, browser, snap, snapFull, log,
//                           sleep, args, out }) => { ... }
//
// Exit codes: 0 ok · 2 driver threw (a failure shot is still taken) ·
// 3 watchdog killed a hung run · 1 harness bug.

import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from 'playwright'

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--') {
      out._.push(...argv.slice(i + 1))
      break
    }
    if (a.startsWith('--')) {
      out[a.slice(2)] = argv[i + 1]
      i++
    } else out._.push(a)
  }
  return out
}

const opts = parseArgs(process.argv.slice(2))
if (!opts.out) {
  console.error('runner: --out is required')
  process.exit(1)
}
const outDir = opts.out
const labRoot = path.resolve(outDir, '..', '..')
const label = opts.label ?? 'run'
const [vw, vh] = (opts.viewport ?? '1280x1300').split('x').map(Number)
const settleMs = Number(opts.settle ?? 1200)
const maxMs = Number(opts['max-ms'] ?? 240_000)

// A hung page must not hang the agent that called us. The watchdog is a hard
// exit, not a graceful close — a wedged Chromium ignores graceful.
const watchdog = setTimeout(() => {
  console.error(`runner: watchdog fired after ${maxMs}ms — killing the run`)
  process.exit(3)
}, maxMs)
watchdog.unref()

const events = []
const counts = { consoleError: 0, consoleWarning: 0, pageError: 0, requestFailed: 0, http4xx: 0, http5xx: 0 }
const now = () => new Date().toISOString()

function attach(page) {
  page.on('console', (m) => {
    const type = m.type()
    if (type === 'error') counts.consoleError++
    if (type === 'warning') counts.consoleWarning++
    // Only warnings and errors are kept: info/log/debug spam would bury the
    // signal this file exists to carry.
    if (type === 'error' || type === 'warning') {
      events.push({ t: now(), kind: 'console', type, text: m.text().slice(0, 600), at: m.location()?.url })
    }
  })
  page.on('pageerror', (err) => {
    counts.pageError++
    events.push({ t: now(), kind: 'pageerror', text: String(err).slice(0, 800) })
  })
  page.on('requestfailed', (r) => {
    counts.requestFailed++
    events.push({ t: now(), kind: 'requestfailed', url: r.url().slice(0, 300), reason: r.failure()?.errorText })
  })
  page.on('response', (res) => {
    const s = res.status()
    if (s < 400) return
    if (s >= 500) counts.http5xx++
    else counts.http4xx++
    events.push({ t: now(), kind: 'http', status: s, url: res.url().slice(0, 300) })
  })
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) events.push({ t: now(), kind: 'nav', url: frame.url().slice(0, 300) })
  })
}

const logs = []
function log(msg) {
  const line = `[${now()}] ${msg}`
  logs.push(line)
  console.log(line)
}

const startedAt = now()
await mkdir(outDir, { recursive: true })

const browser = await chromium.launch({
  // Rootless container: Chrome's own sandbox cannot get the user namespaces
  // it wants, and /dev/shm is compensated for by the CLI's --shm-size.
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
})
const statePath = opts.state ? path.join(labRoot, 'profiles', `${opts.state}.json`) : null
const context = await browser.newContext({
  viewport: { width: vw, height: vh },
  ignoreHTTPSErrors: true,
  ...(statePath && existsSync(statePath) ? { storageState: statePath } : {}),
})
// Fires for every page the run creates, including the first one below.
context.on('page', attach)
const page = await context.newPage()

let shotIndex = 0
const shots = []
const pad = (n) => String(n).padStart(2, '0')

async function snap(name, p = page) {
  const file = `${pad(shotIndex++)}-${name}.png`
  await p.screenshot({ path: path.join(outDir, file) })
  shots.push(file)
  log(`snap ${file}`)
  return file
}

/** The whole page as viewport slices, scrolling as it goes. Capped at 10. */
async function snapFull(name, p = page) {
  const total = await p.evaluate(() => document.body?.scrollHeight ?? 0)
  const slices = Math.max(1, Math.min(10, Math.ceil(total / vh)))
  for (let i = 0; i < slices; i++) {
    await p.evaluate((y) => window.scrollTo(0, y), i * vh)
    await p.waitForTimeout(280)
    await snap(`${name}-${pad(i + 1)}`, p)
  }
  await p.evaluate(() => window.scrollTo(0, 0))
}

const sleep = (ms) => page.waitForTimeout(ms)

let ok = true
let error = null
try {
  if (opts.script) {
    const mod = await import(pathToFileURL(opts.script).href)
    if (typeof mod.default !== 'function') {
      throw new Error('driver must `export default async ({ page, snap, ... }) => { ... }`')
    }
    await mod.default({ page, context, browser, snap, snapFull, log, sleep, args: opts._, out: outDir })
  } else if (opts.url) {
    log(`goto ${opts.url}`)
    await page.goto(opts.url, { waitUntil: 'load', timeout: 45_000 })
    await sleep(settleMs)
    await snapFull('page')
  } else {
    throw new Error('runner: need --script or --url')
  }
  if (statePath) await context.storageState({ path: statePath })
} catch (err) {
  ok = false
  error = String(err?.stack ?? err).slice(0, 2000)
  // The state at the moment of failure is usually the answer.
  try {
    await snap('failure')
  } catch {
    /* page may be gone entirely */
  }
}

await browser.close()
clearTimeout(watchdog)

const finishedAt = now()
const summary = {
  id: path.basename(outDir),
  label,
  ok,
  error,
  startedAt,
  finishedAt,
  durationMs: Date.parse(finishedAt) - Date.parse(startedAt),
  viewport: `${vw}x${vh}`,
  shots,
  counts,
  pages: [...new Set(events.filter((e) => e.kind === 'nav').map((e) => e.url))],
}
await writeFile(path.join(outDir, 'events.json'), JSON.stringify(events, null, 2))
await writeFile(path.join(outDir, 'summary.json'), JSON.stringify(summary, null, 2))
await writeFile(path.join(outDir, 'log.txt'), logs.join('\n') + '\n')

await appendFile(
  path.join(labRoot, 'history.jsonl'),
  JSON.stringify({ id: summary.id, label, ok, startedAt, durationMs: summary.durationMs, counts, shots: shots.length }) +
    '\n',
)
let stats = { totalRuns: 0, failedRuns: 0 }
try {
  stats = JSON.parse(await readFile(path.join(labRoot, 'stats.json'), 'utf8'))
} catch {
  /* first run */
}
stats.totalRuns = (stats.totalRuns ?? 0) + 1
if (!ok) stats.failedRuns = (stats.failedRuns ?? 0) + 1
stats.updatedAt = finishedAt
stats.lastRun = { id: summary.id, label, ok, finishedAt, counts, shots: shots.length }
await writeFile(path.join(labRoot, 'stats.json'), JSON.stringify(stats, null, 2))

console.log(
  `\n${ok ? 'OK' : 'FAILED'} ${summary.id} — ${shots.length} shots · consoleErrors=${counts.consoleError} ` +
    `pageErrors=${counts.pageError} failedRequests=${counts.requestFailed} 4xx=${counts.http4xx} 5xx=${counts.http5xx}`,
)
if (error) console.log(error)
process.exit(ok ? 0 : 2)
