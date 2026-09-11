import { swrCache } from '../../lib/cache'
import type { NixosFacts } from '../../lib/contract/domains/site'
import { githubHeaders } from '../../lib/dashboard/github'
import {
  latestCycle,
  type NixosCycle,
  type NixosNotes,
  notesFile,
  parseNixosNotes,
  supportOf,
} from '../../lib/nixos'
import type { NixosRelease } from './types'

// The live half of Settings › General's Engine card: where the running NixOS
// release stands, what its channel has picked up past the locked commit, and
// the release notes for it and for the newest release.
//
// Three upstreams, none of them on this box:
//   endoflife.date   release and end-of-support dates, per release.
//   GitHub's API     the channel branch's head, and how many commits it is
//                    past the lock. Two calls an hour, with the dashboard's
//                    GitHub token when there is one.
//   raw.githubusercontent.com
//                    the release notes as nixpkgs ships them, from each
//                    release's own `nixos-<release>` branch. Not the API, so
//                    not its rate limit.
//
// Cached an hour, stale answers served through a failure (lib/cache.ts). A
// support window moves twice a year and a stable channel a few times a week.

const cache = swrCache({ ttlMs: 60 * 60_000, retryMs: 5 * 60_000 })
const NIXPKGS = 'NixOS/nixpkgs'
const NOTES_DIR = 'nixos/doc/manual/release-notes'

// Plain fetch on an eight-second budget rather than getJson: that ladder is
// tuned for a stalled socket on the box's own bridge and starts at 400ms,
// which is under a round trip to any of these (see lib/dashboard/github.ts).
async function fetchText(
  url: string,
  headers: Record<string, string> = {},
): Promise<string | null> {
  try {
    const res = await fetch(url, { headers, signal: AbortSignal.timeout(8_000) })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

async function fetchJson<T>(url: string, headers?: Record<string, string>): Promise<T | null> {
  const body = await fetchText(url, headers)
  if (body === null) return null
  try {
    return JSON.parse(body) as T
  } catch {
    return null
  }
}

const text = (v: unknown): string => (typeof v === 'string' ? v : '')

function cycles(): Promise<NixosCycle[] | null> {
  return cache.get('eol', async () => {
    const body = await fetchJson<Record<string, unknown>[]>('https://endoflife.date/api/nixos.json')
    if (!Array.isArray(body)) return null
    return body.flatMap((c): NixosCycle[] =>
      text(c.cycle) === ''
        ? []
        : [
            {
              cycle: text(c.cycle),
              codename: text(c.codename),
              releaseDate: text(c.releaseDate),
              // `false` there means "no date announced", which is not a date.
              eol: text(c.eol),
            },
          ],
    )
  })
}

type Branch = { commit?: { sha?: string; commit?: { committer?: { date?: string } } } }

function branchHead(branch: string): Promise<{ sha: string; date: string } | null> {
  return cache.get(`branch:${branch}`, async () => {
    const body = await fetchJson<Branch>(
      `https://api.github.com/repos/${NIXPKGS}/branches/${branch}`,
      githubHeaders(),
    )
    const sha = body?.commit?.sha
    if (sha === undefined) return null
    return { sha, date: (body?.commit?.commit?.committer?.date ?? '').slice(0, 10) }
  })
}

function newerCommits(base: string, head: string): Promise<number | null> {
  if (base === head) return Promise.resolve(0)
  return cache.get(`compare:${base}...${head}`, async () => {
    const body = await fetchJson<{ ahead_by?: number }>(
      `https://api.github.com/repos/${NIXPKGS}/compare/${base}...${head}?per_page=1`,
      githubHeaders(),
    )
    return typeof body?.ahead_by === 'number' ? body.ahead_by : null
  })
}

async function notesFor(release: string, known: NixosCycle[] | null): Promise<NixosNotes | null> {
  const file = notesFile(release)
  if (file === null) return null
  const parsed = await cache.get(`notes:${release}`, async () => {
    const md = await fetchText(
      `https://raw.githubusercontent.com/${NIXPKGS}/nixos-${release}/${NOTES_DIR}/${file}`,
    )
    return md === null ? null : parseNixosNotes(md)
  })
  if (parsed === null) return null
  return {
    version: release,
    date: known?.find((c) => c.cycle === release)?.releaseDate ?? '',
    url: `https://github.com/${NIXPKGS}/blob/nixos-${release}/${NOTES_DIR}/${file}`,
    ...parsed,
  }
}

export async function nixosRelease(facts: NixosFacts | null): Promise<NixosRelease> {
  const checkedAt = new Date().toISOString()
  const today = checkedAt.slice(0, 10)
  if (facts === null || facts.release === '') {
    return {
      checkedAt,
      running: null,
      support: null,
      latest: null,
      latestSupport: null,
      channel: { branch: '', head: null, newer: null },
      notes: [],
      note: 'the export does not describe the release yet',
    }
  }

  const branch = `nixos-${facts.release}`
  const [known, head] = await Promise.all([cycles(), branchHead(branch)])
  const running = known?.find((c) => c.cycle === facts.release) ?? null
  const latest = known === null ? null : latestCycle(known, today)
  const newer =
    head === null || facts.revision === null ? null : await newerCommits(facts.revision, head.sha)

  const wanted =
    latest !== null && latest.cycle !== facts.release
      ? [latest.cycle, facts.release]
      : [facts.release]
  const notes = (await Promise.all(wanted.map((r) => notesFor(r, known)))).filter(
    (n): n is NixosNotes => n !== null,
  )

  const missing = [
    known === null ? 'endoflife.date did not answer, so the support dates are missing' : null,
    head === null ? `GitHub did not answer for ${branch}` : null,
    notes.length < wanted.length ? 'some release notes could not be read' : null,
  ].filter((m): m is string => m !== null)

  return {
    checkedAt,
    running,
    support: running === null ? null : supportOf(running.eol, today),
    latest,
    latestSupport: latest === null ? null : supportOf(latest.eol, today),
    channel: { branch, head, newer },
    notes,
    note: missing.length === 0 ? null : missing.join('; '),
  }
}
