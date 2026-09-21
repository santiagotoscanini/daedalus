import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { RepoFacts, SiteDir, SiteFile, SiteFileStatus } from '../../host/contract/domains/repo'
import { repoFacts } from '../../host/contract/domains/repo'
import { siteIdentity } from '../../host/contract/domains/site'
import { decodeSiteDocument, readCommittedSite } from '../../host/contract/domains/site-doc'
import type { SnapshotResult } from '../../host/contract/snapshot'
import { env } from '../../host/env'
import { requestSiteWrite, type SiteFileName } from '../../host/site-request'
import { readWorkspaces, workspaceFor } from '../../host/workspaces'
import type { Result } from '../../lib/result'
import { controlPlaneLabelError } from '../../lib/site-fields'
import type { Ctx } from '../ctx'
import { readBoxSettings } from '../settings'
import {
  renderSiteFile,
  renderSiteReadme,
  renderSiteStamp,
  type SiteDocument,
  type SiteStamp,
  type SiteStampDoor,
  siteDocument,
} from './file'

// The site directory, from this container's side.
//
// Since Phase 5 site.json is THE SOURCE of the site constants — nix builds
// from it — so this module is where editing it lives. The model is the one
// the app registry already uses: a stored DESIRED document is the editing
// surface, the COMMITTED file is the contract, and the difference between
// them is what an Apply writes. Before any edit the desired document is
// simply the committed one; after an Apply they agree again.
//
//   committed   /site/site.json, mounted read-only (host/contract/domains/site-doc)
//   desired     the `site.draft` preference, or committed when there is none
//   running     what the box was actually built with (the /export domains, via
//               BoxSettings) — the fallback for the very first write, before a
//               site.json exists at all
//
// "Current" on the Site tab is decided by digest, never by content: the host
// publishes a sha256 per managed file; this hashes the bytes it would write.
// Two files are reported without a comparison: apps.json, which is not
// rendered here at all (only an Apply writes it, from the apps table), and
// daedalus.json, which is rendered here but carries a timestamp — see
// siteState. Server-only.

export type SiteFileView = {
  name: 'site.json' | 'apps.json' | 'README.md' | 'daedalus.json'
  status: SiteFileStatus
  /** Byte-identical to what this box would write now. Null = not compared. */
  current: boolean | null
}

export type SiteState = {
  dir: SiteDir
  files: SiteFileView[]
  /** The operator's switch: commit after every write (staging is not optional). */
  commit: boolean
}

/** The fields nix sources from site.json — the only ones an edit may touch.
    Everything else in the document is still a copy of the configuration.

    The list comes first and the type is read off it, not the other way round.
    Written as `readonly SiteField[]` against a hand-kept union, a field left
    out of the list still typechecks everywhere and the only symptom is a
    settings input that quietly refuses to save. Now there is one declaration,
    so there is nothing to leave out. */
export const EDITABLE = [
  'identity.baseDomain',
  'identity.controlPlane',
  'identity.controlPlanePrevious',
  'identity.timezone',
  'network.lanIp',
  'network.interface',
  'network.gateway',
  'network.wanHost',
  'network.dhcp.active',
  'network.dhcp.router',
  'network.dhcp.start',
  'network.dhcp.end',
  'network.dhcp.leaseTime',
  'network.dnsUpstreams',
  'mail.sender',
  'mail.alertTo',
  'cloudflare.zoneId',
] as const

/** One field of the document that the UI may edit. Dotted path into SiteDocument. */
export type SiteField = (typeof EDITABLE)[number]

export type SiteEdit = {
  /** The committed document; null before the first write. */
  committed: SiteDocument | null
  /** What an Apply would write now: committed ⊕ draft. */
  desired: SiteDocument
  /** The fields where desired differs from committed. Empty = nothing to apply. */
  changes: SiteField[]
  /** Rendered bytes, for the diff preview. `before` is null before the first write. */
  render: { before: string | null; after: string }
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

const isDoc = (v: unknown): v is SiteDocument => {
  try {
    decodeSiteDocument(v)
    return true
  } catch {
    return false
  }
}

async function readDraft(ctx: Ctx): Promise<SiteDocument | null> {
  const { SETTING_KEYS } = await import('../../lib/repo/settings')
  return (await ctx.store.read(SETTING_KEYS.siteDraft, isDoc)) ?? null
}

/**
 * The document as the running system describes itself — the fallback for a
 * box with no site.json yet, and the reference for "what changed since the
 * last rebuild" on the tabs.
 */
export async function runningSite(ctx: Ctx): Promise<SiteDocument> {
  return siteDocument(await readBoxSettings(ctx))
}

export function getField(doc: SiteDocument, field: SiteField): unknown {
  return field.split('.').reduce<unknown>((o, k) => (o as Record<string, unknown>)[k], doc)
}

function setField(doc: SiteDocument, field: SiteField, value: unknown): SiteDocument {
  const keys = field.split('.')
  const out = structuredClone(doc) as unknown as Record<string, unknown>
  let cursor = out
  for (const k of keys.slice(0, -1)) cursor = cursor[k] as Record<string, unknown>
  cursor[keys[keys.length - 1] as string] = value
  return out as unknown as SiteDocument
}

const sameValue = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b)

export function changesBetween(committed: SiteDocument, desired: SiteDocument): SiteField[] {
  return EDITABLE.filter((f) => !sameValue(getField(committed, f), getField(desired, f)))
}

/**
 * A document written before the control plane's label was part of site.json
 * reads it as '' — and nix, seeing no label, keeps the address stacks/daedalus
 * declares. Filled from `from` (the running box), so the page shows the real
 * label and an old file is not reported as a pending rename.
 */
function withControlPlane(doc: SiteDocument, from: SiteDocument): SiteDocument {
  if (doc.identity.controlPlane !== '') return doc
  return {
    ...doc,
    identity: {
      ...doc.identity,
      controlPlane: from.identity.controlPlane,
      controlPlanePrevious: doc.identity.controlPlanePrevious ?? from.identity.controlPlanePrevious,
    },
  }
}

/** Committed, desired, and the difference — what the editable tabs render from. */
export async function siteEdit(ctx: Ctx): Promise<SiteEdit> {
  const committed = await readCommittedSite()
  const running = await runningSite(ctx)
  const committedDoc = committed.ok ? withControlPlane(committed.value.doc, running) : null
  const base = committedDoc ?? running
  const stored = await readDraft(ctx)
  const draft = stored === null ? null : withControlPlane(stored, base)
  // A draft only carries the editable fields' intent: everything else comes
  // from the base, so a hostname or Cloudflare id the configuration moved
  // can never be pinned to a stale value by an old draft.
  const desired =
    draft === null ? base : EDITABLE.reduce((acc, f) => setField(acc, f, getField(draft, f)), base)
  return {
    committed: committedDoc,
    desired,
    changes: committedDoc === null ? [] : changesBetween(committedDoc, desired),
    render: { before: committed.ok ? committed.value.bytes : null, after: renderSiteFile(desired) },
  }
}

/**
 * The two edits whose valid values are a list somebody else owns.
 *
 * A timezone must be one this system's tzdata names: NixOS accepts any string
 * there, and a box handed a zone its tzdata lacks has no local time at all. A
 * domain must arrive with the id of a zone the Cloudflare API token can see,
 * and the two must agree, or traefik asks for a certificate in a zone the
 * token cannot touch and the tunnel's reconciler writes records into the old
 * one. Putting a field back to its committed value is always allowed, so an
 * edit can be undone while Cloudflare is unreachable.
 */
async function refuseUnknown(
  ctx: Ctx,
  patch: Partial<Record<SiteField, unknown>>,
  committed: SiteDocument | null,
  next: SiteDocument,
  requestHost: string | null,
): Promise<void> {
  const unchanged = (f: SiteField) =>
    committed !== null && sameValue(getField(committed, f), patch[f])

  // The control plane's name. A label the build would refuse, the landing
  // page's name, or a hostname some other app already answers at never gets
  // as far as a draft.
  if ('identity.controlPlane' in patch && !unchanged('identity.controlPlane')) {
    const label = patch['identity.controlPlane']
    const problem =
      typeof label === 'string' ? controlPlaneLabelError(label) : 'the name must be text'
    if (problem !== null) throw new Error(problem)
    if (committed !== null && committed.identity.baseDomain !== next.identity.baseDomain) {
      throw new Error(
        'Change the domain and the control plane’s name in separate Applies: the old address is only kept answering under the domain it was on.',
      )
    }
    const domain = next.identity.baseDomain
    const host = `${String(label)}.${domain}`
    const own = [committed?.identity.controlPlane, committed?.identity.controlPlanePrevious]
      .filter((l): l is string => typeof l === 'string' && l !== '')
      .map((l) => `${l}.${domain}`)
    const { publishingFacts } = await import('../../host/contract/domains/publishing')
    const { takenHostnames } = await publishingFacts()
    if (takenHostnames.includes(host) && !own.includes(host)) {
      throw new Error(`${host} is already published on this box.`)
    }
  }

  // Retiring the old address. Only from the new one, since reaching the page
  // there is the proof that it works — the one thing the old address being
  // kept was waiting for.
  if ('identity.controlPlanePrevious' in patch && !unchanged('identity.controlPlanePrevious')) {
    if (patch['identity.controlPlanePrevious'] !== null) {
      throw new Error('the earlier address is kept by a rename, not set by hand')
    }
    const was = committed?.identity
    if (was === undefined || was.controlPlanePrevious === null) {
      throw new Error('there is no earlier address to retire')
    }
    const confirmed = `${was.controlPlane}.${was.baseDomain}`
    if (requestHost !== confirmed) {
      throw new Error(
        `Confirm from https://${confirmed} itself — reaching this page there is what proves the new address works.`,
      )
    }
  }

  if ('identity.timezone' in patch && !unchanged('identity.timezone')) {
    const { readTimezones } = await import('../settings/timezones')
    const tz = patch['identity.timezone']
    if (typeof tz !== 'string' || !(await readTimezones()).includes(tz)) {
      throw new Error(`${String(tz)} is not a timezone this system's tzdata names`)
    }
  }

  const domain = 'identity.baseDomain' in patch
  const zone = 'cloudflare.zoneId' in patch
  if (!domain && !zone) return
  if (!domain || !zone) throw new Error('the domain and its Cloudflare zone are saved together')
  if (unchanged('identity.baseDomain') && unchanged('cloudflare.zoneId')) return
  const { listZones } = await import('../settings/zones')
  const list = await listZones(ctx)
  if (!list.ok) throw new Error(`${list.reason}, so the zone cannot be confirmed`)
  const match = list.value.find((z) => z.id === patch['cloudflare.zoneId'])
  if (match === undefined || match.name !== patch['identity.baseDomain']) {
    throw new Error(
      `${String(patch['identity.baseDomain'])} is not a zone the Cloudflare API token can see`,
    )
  }
}

/**
 * Record an edit. The draft stored is the whole desired document, so the
 * editing surface survives a reload and a second edit composes with the
 * first. Setting a field back to its committed value is how an edit is
 * undone; when nothing differs the draft is dropped rather than kept as a
 * copy.
 */
/**
 * Serve-both-until-confirmed, decided here and not by the page: renaming the
 * control plane keeps the committed label as the previous address, which nix
 * serves as an alias, so a rename can never lock the operator out of the page
 * that would undo it. Putting the label back restores what was committed. A
 * second rename while one is unconfirmed is refused — there would be two old
 * addresses and a single alias.
 */
function keepPreviousAddress(
  committed: SiteDocument | null,
  patch: Partial<Record<SiteField, unknown>>,
  next: SiteDocument,
): SiteDocument {
  if (committed === null || !('identity.controlPlane' in patch)) return next
  if ('identity.controlPlanePrevious' in patch) return next
  const was = committed.identity
  if (next.identity.controlPlane === was.controlPlane) {
    return setField(next, 'identity.controlPlanePrevious', was.controlPlanePrevious)
  }
  if (was.controlPlanePrevious !== null) {
    throw new Error(
      `Confirm the move to ${was.controlPlane} first — ${was.controlPlanePrevious} is still answering beside it.`,
    )
  }
  return setField(
    next,
    'identity.controlPlanePrevious',
    was.controlPlane === '' ? null : was.controlPlane,
  )
}

export async function saveSiteEdit(
  ctx: Ctx,
  patch: Partial<Record<SiteField, unknown>>,
  opts: { requestHost: string | null } = { requestHost: null },
): Promise<SiteEdit> {
  const { SETTING_KEYS } = await import('../../lib/repo/settings')
  const current = await siteEdit(ctx)
  let next = current.desired
  for (const [field, value] of Object.entries(patch) as [SiteField, unknown][]) {
    if (!EDITABLE.includes(field)) throw new Error(`${field} is not editable`)
    next = setField(next, field, value)
  }
  next = keepPreviousAddress(current.committed, patch, next)
  await refuseUnknown(ctx, patch, current.committed, next, opts.requestHost)
  // Validate the whole document, not the patch: a field's type is decided by
  // the decoder, and a patch that produces an undecodable document is refused
  // before it is stored.
  decodeSiteDocument(JSON.parse(renderSiteFile(next)))
  if (current.committed !== null && changesBetween(current.committed, next).length === 0) {
    // Dropped, not nulled: the settings column is NOT NULL, and writing null
    // here was the one way to make "put it back" fail while every other edit
    // succeeded.
    await ctx.store.delete(SETTING_KEYS.siteDraft)
  } else {
    await ctx.store.write(SETTING_KEYS.siteDraft, next)
  }
  return siteEdit(ctx)
}

// --- the provenance stamp -------------------------------------------------
//
// daedalus.json answers "which engine wrote this directory, and when" for
// somebody reading the repository's history months later. It is written by
// BOTH doors, so every write into site/ refreshes it, and nix never reads it.
//
// The one rule the gatherers below all obey: a fact this container cannot
// READ is null. Not a default, not an empty string, not a stale value from a
// snapshot whose producer stopped. A stamp that occasionally invents a
// revision is worth less than no stamp, because nothing distinguishes the
// invented entries from the real ones afterwards.

/** The engine's own repository, as the workspace snapshot names its remote. */
const ENGINE_REPO = 'santiagotoscanini/daedalus'

/** A snapshot's data, or null when it is missing, undecodable or stale. */
function fresh<T>(snap: SnapshotResult<T>): T | null {
  return snap.available && !snap.stale ? snap.data : null
}

const nonEmpty = (v: string | null | undefined): string | null =>
  typeof v === 'string' && v !== '' ? v : null

/**
 * The engine's package version. Read from the source tree the dev server is
 * running out of (`/app`, the workspace clone daedalus.nix bind-mounts), which
 * is the only place this container can learn it — the version is not in the
 * environment and no snapshot carries it.
 */
async function engineVersion(): Promise<string | null> {
  try {
    const path = env.get('ENGINE_PACKAGE_JSON') ?? join(process.cwd(), 'package.json')
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'))
    const version = (parsed as { version?: unknown }).version
    return typeof version === 'string' ? nonEmpty(version) : null
  } catch {
    return null
  }
}

/**
 * Which commit of the engine is serving this write, from the workspace
 * snapshot. Stale means the sync timer stopped, and a head from an unknown
 * number of hours ago is exactly the kind of plausible-looking wrong answer
 * this file exists to avoid — so a stale snapshot yields nulls.
 */
async function engineFacts(): Promise<SiteStamp['engine']> {
  const version = await engineVersion()
  const data = fresh(await readWorkspaces())
  const ws = data === null ? null : workspaceFor(ENGINE_REPO, data)
  if (ws === null) return { version, head: null, dirty: null, branch: null }
  return { version, head: nonEmpty(ws.head), dirty: ws.dirty, branch: nonEmpty(ws.branch) }
}

/**
 * The provenance stamp's bytes.
 *
 * `config.revision` is the configuration repository's HEAD as it stands
 * BEFORE this write — the commit these files were rendered against. The
 * commit this write creates cannot be in its own stamp.
 */
export async function renderSiteStampFile(door: SiteStampDoor, actor: string): Promise<string> {
  const [engine, repo, identity] = await Promise.all([engineFacts(), repoFacts(), siteIdentity()])
  return renderSiteStamp({
    writtenAt: new Date().toISOString(),
    writtenBy: { actor, door },
    engine,
    config: { revision: nonEmpty(fresh(repo)?.head?.rev) },
    nixos: { version: nonEmpty(fresh(identity)?.nixos?.version) },
  })
}

/** The bytes the Site tab's "Write" action hands to the host. */
export async function renderSiteFiles(
  ctx: Ctx,
  actor: string,
): Promise<Record<SiteFileName, string>> {
  const { desired } = await siteEdit(ctx)
  return {
    'site.json': renderSiteFile(desired),
    'README.md': renderSiteReadme(desired),
    'daedalus.json': await renderSiteStampFile('site-write', actor),
  }
}

export async function siteState(ctx: Ctx, facts?: RepoFacts): Promise<SiteState> {
  const dir = (facts ?? (await repoFacts()).data).site
  const { desired } = await siteEdit(ctx)
  const compare = (f: SiteFile, bytes: string): boolean | null =>
    f.sha256 === null ? null : f.sha256 === sha256(bytes)
  const files = dir.files
  return {
    dir,
    files: [
      {
        name: 'site.json',
        status: files['site.json'].status,
        current: compare(files['site.json'], renderSiteFile(desired)),
      },
      { name: 'apps.json', status: files['apps.json'].status, current: null },
      {
        name: 'README.md',
        status: files['README.md'].status,
        current: compare(files['README.md'], renderSiteReadme(desired)),
      },
      // Never compared, for the same reason apps.json is not — but a
      // different one. apps.json is not rendered here at all; daedalus.json
      // IS, and still cannot be compared: it carries `writtenAt`, so the
      // bytes this box would write now differ from the committed ones by
      // construction and "differs" would be the permanent answer. A digest
      // that is always red says nothing.
      { name: 'daedalus.json', status: files['daedalus.json'].status, current: null },
    ],
    commit: await readSiteCommit(ctx),
  }
}

/** The request id the caller polls for, or why the host would not take it. */
export type WriteOutcome = Result<string>

/**
 * Ask the host to write site.json (with the README and the stamp) as desired.
 * This is the
 * Site tab's door and does NOT rebuild — it exists for the first write, and
 * for a directory that fell out of step. A change to a value nix reads goes
 * through Apply (host/apply-flow.ts), which writes the same bytes and rebuilds.
 */
export async function writeSite(ctx: Ctx, actor: string): Promise<WriteOutcome> {
  const { readSiteRequestStatus } = await import('../../host/site-request')
  const inFlight = await readSiteRequestStatus()
  if (inFlight.state === 'running') {
    return { ok: false, reason: `the host is already working on this (${inFlight.phase})` }
  }
  const id = await requestSiteWrite({
    commit: await readSiteCommit(ctx),
    summary: 'site: what this box is',
    actor,
    files: await renderSiteFiles(ctx, actor),
  })
  return { ok: true, value: id }
}
