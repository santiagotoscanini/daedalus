import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import type { FileDigest, SiteRepo, SiteRepoState } from '../../lib/contract/domains/repo'
import { repoFacts } from '../../lib/contract/domains/repo'
import { requestSiteInit, type SiteFileName } from '../../lib/site-request'
import type { Ctx } from '../ctx'
import { readBoxSettings } from '../settings'
import { renderSiteFile, renderSiteReadme, siteDocument } from './file'

// The site repository, from this container's side: render what should be in
// it, and say whether what IS in it agrees.
//
// The comparison is by digest, never by content. The host publishes a sha256
// per managed file (host/repo-snapshot.sh); this hashes the same bytes it
// would write and compares. So "in sync" is a real claim about the committed
// file, made without either side reading the other's copy — which is the
// whole argument for calling the repo a verified mirror rather than a second
// place to look.
//
// ⚠ What the mirror holds is what the RUNNING SYSTEM WAS BUILT FROM, not what
// daedalus would build next. For apps.json that distinction is the whole
// thing: the registry's editing surface is a Postgres table, and between an
// edit and an Apply the table and the committed file legitimately disagree.
// Writing a fresh render of the table into this repository would commit
// unapplied changes into the one file whose entire claim is that it describes
// the machine as it is — and the drift the Apps page exists to report would
// quietly become the site repo's version of the truth. So apps.json is copied
// from /export/applied.json, the byte copy of the committed file that
// daedalus-registry-snapshot publishes, and it moves when an Apply moves it.
//
// Server-only: it reads snapshots off the filesystem.

export type MirrorState =
  | 'in-sync'
  /** Committed, but not what this box was built from. */
  | 'differs'
  /** The repository exists and this file is not in it. */
  | 'missing'

export type MirrorFile = {
  name: SiteFileName
  state: MirrorState
  rendered: FileDigest
  committed: FileDigest | null
}

export type SiteMirror = {
  repo: SiteRepo
  /** Empty until the repository exists — there is nothing to compare against. */
  files: MirrorFile[]
  inSync: boolean
}

function digestOf(body: string): FileDigest {
  return {
    sha256: createHash('sha256').update(body, 'utf8').digest('hex'),
    bytes: Buffer.byteLength(body, 'utf8'),
  }
}

/**
 * The bytes this box would commit right now.
 *
 * README.md is written once and never compared — see renderSiteReadme. It is
 * returned here anyway because Initialize writes it, and a repository whose
 * front page appeared only on a second run would be odd.
 *
 * Throws when the applied registry is unreadable. That is the correct
 * failure: a site repository without the registry the system was built from
 * is not a partial mirror, it is a misleading one.
 */
export async function renderSiteFiles(ctx: Ctx): Promise<Record<SiteFileName, string>> {
  const applied = ctx.exportPath('applied.json')
  const registry = await readFile(applied, 'utf8').catch((e: unknown) => {
    throw new Error(
      `could not read the applied registry at ${applied}: ${e instanceof Error ? e.message : String(e)}`,
    )
  })

  const doc = siteDocument(await readBoxSettings(ctx))

  return {
    'site.json': renderSiteFile(doc),
    'apps.json': registry,
    'README.md': renderSiteReadme(doc),
  }
}

/** The managed files, in the order the tab lists them. `README.md` is not one. */
const COMPARED: SiteFileName[] = ['site.json', 'apps.json']

export async function siteMirror(ctx: Ctx): Promise<SiteMirror> {
  const facts = await repoFacts()
  const repo = facts.data.site

  if (repo.state !== ('ready' satisfies SiteRepoState)) {
    return { repo, files: [], inSync: false }
  }

  const bodies = await renderSiteFiles(ctx)
  const committed: Record<string, FileDigest | null> = {
    'site.json': repo.files.site,
    'apps.json': repo.files.apps,
  }

  const files = COMPARED.map((name): MirrorFile => {
    const rendered = digestOf(bodies[name])
    const c = committed[name] ?? null
    return {
      name,
      rendered,
      committed: c,
      state: c === null ? 'missing' : c.sha256 === rendered.sha256 ? 'in-sync' : 'differs',
    }
  })

  return { repo, files, inSync: files.every((f) => f.state === 'in-sync') }
}

export type InitOutcome = { ok: true; id: string } | { ok: false; reason: string }

/**
 * Create or adopt the repository and commit the current render into it.
 *
 * Idempotent on the host side, so this does not try to decide whether there
 * is anything to do — it asks, and the agent reports "no change" when the
 * files it wrote were already the files that were there.
 */
export async function initSite(
  ctx: Ctx,
  input: { actor: string; remote: string; createRemote: boolean },
): Promise<InitOutcome> {
  const { readSiteRequestStatus } = await import('../../lib/site-request')

  const inFlight = await readSiteRequestStatus()
  if (inFlight.state === 'running') {
    return { ok: false, reason: `the host is already working on this (${inFlight.phase})` }
  }

  let files: Record<SiteFileName, string>
  try {
    files = await renderSiteFiles(ctx)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }

  const id = await requestSiteInit({
    remote: input.remote,
    createRemote: input.createRemote,
    summary: 'site: what this box is',
    actor: input.actor,
    files,
  })
  return { ok: true, id }
}
