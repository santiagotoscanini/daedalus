import { createHash } from 'node:crypto'
import type { RepoFacts, SiteDir, SiteFileStatus } from '../../lib/contract/domains/repo'
import { repoFacts } from '../../lib/contract/domains/repo'
import { decodeSiteDocument, readCommittedSite } from '../../lib/contract/domains/site-doc'
import { controlPlaneLabelError } from '../../lib/site-fields'
import { requestSiteWrite, type SiteFileName } from '../../lib/site-request'
import type { Ctx } from '../ctx'
import { readBoxSettings } from '../settings'
import { renderSiteFile, renderSiteReadme, type SiteDocument, siteDocument } from './file'

// The site directory, from this container's side.
//
// Since Phase 5 site.json is THE SOURCE of the site constants — nix builds
// from it — so this module is where editing it lives. The model is the one
// the app registry already uses: a stored DESIRED document is the editing
// surface, the COMMITTED file is the contract, and the difference between
// them is what an Apply writes. Before any edit the desired document is
// simply the committed one; after an Apply they agree again.
//
//   committed   /site/site.json, mounted read-only (lib/contract/domains/site-doc)
//   desired     the `site.draft` preference, or committed when there is none
//   running     what the box was actually built with (the /export domains, via
//               BoxSettings) — the fallback for the very first write, before a
//               site.json exists at all
//
// "Current" on the Site tab is decided by digest, never by content: the host
// publishes a sha256 per managed file; this hashes the bytes it would write.
// apps.json is NOT rendered here — only an Apply writes it, from the apps
// table — this module reports its status and nothing more. Server-only.

export type SiteFileView = {
  name: 'site.json' | 'apps.json'
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

/** One field of the document that the UI may edit. Dotted path into SiteDocument. */
export type SiteField =
  | 'identity.baseDomain'
  | 'identity.controlPlane'
  | 'identity.controlPlanePrevious'
  | 'identity.timezone'
  | 'network.lanIp'
  | 'network.interface'
  | 'network.gateway'
  | 'network.wanHost'
  | 'network.dhcp.active'
  | 'network.dhcp.router'
  | 'network.dhcp.start'
  | 'network.dhcp.end'
  | 'network.dhcp.leaseTime'
  | 'network.dnsUpstreams'
  | 'mail.sender'
  | 'mail.alertTo'
  | 'cloudflare.zoneId'

/** The fields nix sources from site.json — the only ones an edit may touch.
    Everything else in the document is still a copy of the configuration. */
export const EDITABLE: readonly SiteField[] = [
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
]

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
  const committedDoc = committed.present ? withControlPlane(committed.doc, running) : null
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
    render: { before: committed.present ? committed.bytes : null, after: renderSiteFile(desired) },
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
    const { publishingFacts } = await import('../../lib/contract/domains/publishing')
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
  const match = list.zones.find((z) => z.id === patch['cloudflare.zoneId'])
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

/** The bytes the Site tab's "Write" action hands to the host. */
export async function renderSiteFiles(ctx: Ctx): Promise<Record<SiteFileName, string>> {
  const { desired } = await siteEdit(ctx)
  return { 'site.json': renderSiteFile(desired), 'README.md': renderSiteReadme(desired) }
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

/**
 * Ask the host to write site.json (and the README) as desired. This is the
 * Site tab's door and does NOT rebuild — it exists for the first write, and
 * for a directory that fell out of step. A change to a value nix reads goes
 * through Apply (lib/apply-flow.ts), which writes the same bytes and rebuilds.
 */
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
