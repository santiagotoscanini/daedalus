import { createHash } from 'node:crypto'
import type { RepoFacts, SiteDir, SiteFileStatus } from '../../lib/contract/domains/repo'
import { repoFacts } from '../../lib/contract/domains/repo'
import { requestSiteWrite, type SiteFileName } from '../../lib/site-request'
import type { Ctx } from '../ctx'
import { readBoxSettings } from '../settings'
import { renderSiteFile, renderSiteReadme, siteDocument } from './file'

// The site directory, from this container's side: render what should be in
// it, say whether what IS in it agrees, and ask the host to write it.
//
// "Current" is decided by digest, never by content. The host publishes a
// sha256 per managed file (host/repo-snapshot.sh); this hashes the bytes it
// would write and compares. So the claim is about the committed file, made
// without either side reading the other's copy.
//
// apps.json is NOT rendered here. Only an Apply writes it (from Phase 4), so
// it can never hold unapplied drift; this module reports its status and
// nothing more. Server-only: it reads snapshots off the filesystem and the
// preferences store.

export type SiteFileView = {
  name: 'site.json' | 'apps.json'
  status: SiteFileStatus
  /** Byte-identical to what this box would write now. Null = not compared
      (apps.json, or the file is absent). */
  current: boolean | null
}

export type SiteState = {
  dir: SiteDir
  files: SiteFileView[]
  /** The operator's switch: commit after every write (staging is not optional). */
  commit: boolean
}

function sha256(body: string): string {
  return createHash('sha256').update(body, 'utf8').digest('hex')
}

const isBool = (v: unknown): v is boolean => typeof v === 'boolean'

export async function readSiteCommit(ctx: Ctx): Promise<boolean> {
  const { SETTING_KEYS } = await import('../../lib/repo/settings')
  return (await ctx.store.read(SETTING_KEYS.siteCommit, isBool)) ?? false
}

export async function writeSiteCommit(ctx: Ctx, value: boolean): Promise<void> {
  const { SETTING_KEYS } = await import('../../lib/repo/settings')
  await ctx.store.write(SETTING_KEYS.siteCommit, value)
}

/** The bytes this box would write right now. */
export async function renderSiteFiles(ctx: Ctx): Promise<Record<SiteFileName, string>> {
  const doc = siteDocument(await readBoxSettings(ctx))
  return { 'site.json': renderSiteFile(doc), 'README.md': renderSiteReadme(doc) }
}

export async function siteState(ctx: Ctx, facts?: RepoFacts): Promise<SiteState> {
  const dir = (facts ?? (await repoFacts()).data).site
  const bodies = await renderSiteFiles(ctx)
  const rendered = sha256(bodies['site.json'])

  const site = dir.files['site.json']
  const apps = dir.files['apps.json']
  return {
    dir,
    files: [
      {
        name: 'site.json',
        status: site.status,
        current: site.sha256 === null ? null : site.sha256 === rendered,
      },
      { name: 'apps.json', status: apps.status, current: null },
    ],
    commit: await readSiteCommit(ctx),
  }
}

export type WriteOutcome = { ok: true; id: string } | { ok: false; reason: string }

/** Ask the host to write site.json (and the README) as this box is now. */
export async function writeSite(ctx: Ctx, actor: string): Promise<WriteOutcome> {
  const { readSiteRequestStatus } = await import('../../lib/site-request')
  const inFlight = await readSiteRequestStatus()
  if (inFlight.state === 'running') {
    return { ok: false, reason: `the host is already working on this (${inFlight.phase})` }
  }
  const id = await requestSiteWrite({
    commit: await readSiteCommit(ctx),
    summary: 'site: what this box is',
    actor,
    files: await renderSiteFiles(ctx),
  })
  return { ok: true, id }
}
