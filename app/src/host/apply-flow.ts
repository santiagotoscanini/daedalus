import type { Ctx } from '../core/ctx'
import { siteBarFields } from '../lib/module-switch'
import type { Result } from '../lib/result'
import { defineFlow, defineGate, type FlowOutcome } from './flow'

// The one apply implementation.
//
// Both doors — the Apply button's server function (server/registry.ts) and
// the MCP `apply` tool (host/mcp/server.ts) — call runApply and only translate
// its outcome into their own response shape, so the two cannot drift.
//
// runSecretApply is the third door, for a vault secret set from Settings
// (core/settings/cloudflare-token.ts, core/settings/github-app.ts). It shares
// the lock and the busy checks, and differs in one rule: it is always its own
// Apply.
//
// The lock and the order of the steps are host/flow.ts's; the root helper
// runs one Apply at a time.
// What is here is what an Apply IS: what it carries, and when there is nothing
// to carry.

/**
 * `noop` is runApply's, `pending` is runSecretApply's; one union because
 * the doors that render a refusal do not care which flow it came from. The
 * `code` is the word a machine caller branches on: the MCP tool puts it in
 * front of the sentence, and the button shows only the sentence.
 */
export type ApplyOutcome = FlowOutcome<
  { changed: { name: string; fields: string[] }[] },
  'noop' | 'pending'
>

type WithCtx = { ctx: Pick<Ctx, 'controller'> }

// ONE gate for both flows below: they start the same verb, so a secret's Apply
// and a registry Apply must refuse each other.
const gate = defineGate({
  readStatus: async (input: WithCtx) => (await import('./apply')).readApplyStatus(input.ctx),
  running: (inFlight) => `an apply is already running (${inFlight.phase})`,
})
/**
 * What an Apply would carry right now: app drift, site-document edits and the
 * machines. The one definition — the Apply bar (host/pending-apply.ts), the
 * preview and both flows below all read it.
 */
export async function currentChanges() {
  const { listApps } = await import('../lib/repo/apps')
  const { driftOf } = await import('../lib/apps/manifest-map')
  const { manifestEntries } = await import('./nix-manifest')

  const records = await listApps()
  const manifest = new Map((await manifestEntries()).map((m) => [m.name, m]))

  const appChanges = records
    .filter((r) => !r.managedInNix)
    .map((r) => ({ name: r.name, fields: driftOf(r, manifest.get(r.name)) }))
    .filter((c) => c.fields.length > 0)

  // The site document rides the same Apply: one rebuild for everything that
  // changed, in whichever file. Its changes are listed under the name `site`
  // so the bar can say what they are beside the apps.
  const { makeCtx } = await import('../core/ctx')
  const { siteEdit } = await import('../core/site')
  const site = await siteEdit(await makeCtx())

  // The machines ride it too: nodes.json is rendered from the nodes table
  // every Apply, and counts as a change when its bytes differ from the
  // committed file — a join, a rename, a provider switched on or off.
  const nodesFile = await nodesChange()

  const changed = [
    ...appChanges,
    // The switches field is one entry in `changes` and several words on the
    // bar: "n8n off" says more than the field's name.
    ...(site.changes.length > 0
      ? [
          {
            name: 'site',
            fields: siteBarFields(site.changes, site.moduleChanges),
          },
        ]
      : []),
    ...(nodesFile.changed ? [{ name: 'nodes', fields: nodesFile.fields }] : []),
  ]

  return { records, site, nodesFile, changed }
}

/**
 * nodes.json as this Apply would write it, against the committed one. The
 * fields name the difference in words the bar can show: "gaming-pc joined",
 * "macbook-pro renamed", "gaming-pc offers lemonade".
 */
export async function nodesChange(): Promise<{ text: string; changed: boolean; fields: string[] }> {
  const { readFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  const { env } = await import('./env')
  const { nodesForFile } = await import('../lib/repo/nodes')
  const { parseNodesFile, renderNodesFile } = await import('../lib/nodes-file')

  const wanted = await nodesForFile()
  const text = renderNodesFile(wanted)
  let committedText: string | null = null
  try {
    committedText = await readFile(join(env.get('SITE_PATH'), 'nodes.json'), 'utf8')
  } catch {
    committedText = null
  }
  if (committedText === text) return { text, changed: false, fields: [] }
  // No file and no machines say the same thing to nix (platform/site.nix
  // reads the file only when it exists), so a box that never enrolled one
  // is not forever one Apply behind.
  if (committedText === null && wanted.length === 0) return { text, changed: false, fields: [] }

  let before = new Map<string, { name: string; providers: string[] }>()
  try {
    before = new Map(
      (committedText === null ? [] : parseNodesFile(JSON.parse(committedText)).nodes).map((n) => [
        n.id,
        { name: n.name, providers: Object.keys(n.providers).sort() },
      ]),
    )
  } catch {
    before = new Map()
  }
  const fields: string[] = []
  for (const n of wanted) {
    const was = before.get(n.id)
    const offers = Object.entries(n.providers)
      .filter(([, p]) => p.offer)
      .map(([k]) => k)
      .sort()
    if (was === undefined) {
      fields.push(`${n.name} joined${offers.length > 0 ? ` (offers ${offers.join(', ')})` : ''}`)
      continue
    }
    if (was.name !== n.name) fields.push(`${was.name} renamed ${n.name}`)
    for (const k of offers) if (!was.providers.includes(k)) fields.push(`${n.name} offers ${k}`)
    for (const k of was.providers)
      if (!offers.includes(k)) fields.push(`${n.name} stops offering ${k}`)
  }
  for (const [id, was] of before) {
    if (!wanted.some((n) => n.id === id)) fields.push(`${was.name} left`)
  }
  if (fields.length === 0) fields.push(`${String(wanted.length)} nodes`)
  return { text, changed: true, fields }
}

export async function commitSwitch(): Promise<boolean> {
  const { readSetting, SETTING_KEYS } = await import('../lib/repo/settings')
  // Whether the host commits the write under site/ — the same switch the
  // Site tab sets. Off means staged and left to the operator.
  return (
    (await readSetting(SETTING_KEYS.siteCommit, (v): v is boolean => typeof v === 'boolean')) ??
    false
  )
}

type ApplyInput = WithCtx & { actor: string }

const apply = defineFlow<ApplyInput, { changed: { name: string; fields: string[] }[] }, 'noop'>(
  gate,
  {
    prepare: async ({ ctx, actor }) => {
      const { toRegistryExport } = await import('../lib/apps/manifest-map')
      const { startApply, summarise } = await import('./apply')
      const { renderRegistryFile } = await import('../lib/registry-file')
      const { renderSiteMeta } = await import('../core/site')

      const { records, site, nodesFile, changed } = await currentChanges()
      if (changed.length === 0) {
        return { ok: false, code: 'noop', reason: 'nothing to apply' }
      }

      return {
        ok: true,
        value: { changed },
        publish: async () => {
          const started = await startApply(ctx, {
            // Finished files, not data structures: the host agent writes these
            // bytes verbatim and never parses them. apps.json and nodes.json
            // always — their renders are idempotent and the agent reports
            // no-change; site.json only when its desired document differs from
            // the committed one; README.md and daedalus.json always — the README
            // is rendered from the document, and the point of the stamp is that
            // every write into the directory says which engine made it.
            files: {
              'apps.json': renderRegistryFile(toRegistryExport(records)),
              'nodes.json': nodesFile.text,
              ...(site.changes.length > 0 ? { 'site.json': site.render.after } : {}),
              ...(await renderSiteMeta(site.desired, actor)),
            },
            summary: summarise(changed),
            actor,
            commit: await commitSwitch(),
          })
          return started.ok ? started.id : started
        },
      }
    },
  },
)

export function runApply(ctx: Pick<Ctx, 'controller'>, actor: string): Promise<ApplyOutcome> {
  return apply({ ctx, actor })
}

/**
 * Throw away what an Apply would carry, back to what the last one built.
 *
 * The site draft is dropped; an app edited since that build gets the build's
 * manifest entry back (`revertApp`). Two kinds of change are not edits and
 * stay, named in `kept`: an app created since the last Apply (discarding it
 * would mean deleting it — its page does that, deliberately), and the
 * machines (nodes.json follows the nodes table, which records machines that
 * joined or were renamed, not a draft). Refused while an Apply runs, since
 * that Apply is writing exactly these records.
 */
export async function discardChanges(
  ctx: Pick<Ctx, 'controller' | 'store'>,
): Promise<Result<{ discarded: string[]; kept: string[] }>> {
  const blocked = await gate.blocked({ ctx })
  if (blocked !== null) return { ok: false, reason: blocked.reason }

  const { SETTING_KEYS } = await import('../lib/repo/settings')
  const { revertApp } = await import('../lib/repo/apps')
  const { manifestEntries } = await import('./nix-manifest')
  const manifest = new Map((await manifestEntries()).map((m) => [m.name, m]))
  const { changed } = await currentChanges()

  const discarded: string[] = []
  const kept: string[] = []
  for (const c of changed) {
    if (c.name === 'site') {
      await ctx.store.delete(SETTING_KEYS.siteDraft)
      discarded.push('the site')
    } else if (c.name === 'nodes') {
      kept.push('the machines')
    } else {
      const entry = manifest.get(c.name)
      if (entry === undefined || entry.awaitingImage === true) {
        kept.push(`${c.name} (new since the last Apply)`)
      } else {
        await revertApp(c.name, entry)
        discarded.push(c.name)
      }
    }
  }
  return { ok: true, value: { discarded, kept } }
}

export type VaultFile = import('../lib/vault').VaultFile

const pendingReason = (other: { name: string }[]) =>
  `Apply or undo the pending changes first (${other.map((c) => c.name).join(', ')}): replacing a secret is its own Apply.`

/**
 * Why a vault secret could not be applied right now, or null when it could.
 *
 * For work that cannot be repeated for free, asked before it starts: creating
 * a GitHub App mints a key, and one minted and then refused here is a key
 * nobody can use. runSecretApply asks again at the moment it writes.
 */
export async function secretApplyBlocker(ctx: Pick<Ctx, 'controller'>): Promise<string | null> {
  const blocked = await gate.blocked({ ctx })
  if (blocked !== null) return blocked.reason
  const { changed } = await currentChanges()
  return changed.length > 0 ? pendingReason(changed) : null
}

type SecretApply = WithCtx & {
  actor: string
  secret: { file: VaultFile; name: string; ciphertext: string }
  extraFiles?: Pick<import('./apply').ApplyFiles, 'site.json'>
}

const secretApply = defineFlow<
  SecretApply,
  { changed: { name: string; fields: string[] }[] },
  'pending'
>(gate, {
  prepare: async ({ ctx, actor, secret, extraFiles }) => {
    const { startApply } = await import('./apply')
    const { renderSiteMeta } = await import('../core/site')

    const { changed: other, site } = await currentChanges()
    if (other.length > 0) {
      return { ok: false, code: 'pending', reason: pendingReason(other) }
    }

    return {
      ok: true,
      value: { changed: [{ name: 'vault', fields: [secret.name] }] },
      publish: async () => {
        const started = await startApply(ctx, {
          // The README and the stamp ride this door too — every write into the
          // directory records what wrote it. Neither changes the commit's
          // subject: the agent leaves both out of that decision, so this stays
          // `vault: replace …`.
          files: {
            ...extraFiles,
            [secret.file]: secret.ciphertext,
            ...(await renderSiteMeta(site.desired, actor)),
          },
          summary: `replace ${secret.name}`,
          actor,
          commit: await commitSwitch(),
        })
        return started.ok ? started.id : started
      },
    }
  },
})

/**
 * Replace one vault secret. Always its own Apply: refused while anything else
 * is pending, so a rotation never rides along with an unrelated change (nor an
 * unrelated change with it), and its commit names only which secret moved —
 * never a value, which this function only ever holds as ciphertext.
 *
 * `extraFiles` ride the same request, for a secret whose public half belongs
 * in site.json (the GitHub App's id beside its sealed key): rendered by the
 * caller from the COMMITTED document, since anything pending is refused here.
 */
export function runSecretApply(
  ctx: Pick<Ctx, 'controller'>,
  actor: string,
  secret: { file: VaultFile; name: string; ciphertext: string },
  opts?: { extraFiles?: Pick<import('./apply').ApplyFiles, 'site.json'> },
): Promise<ApplyOutcome> {
  return secretApply({
    ctx,
    actor,
    secret,
    ...(opts?.extraFiles === undefined ? {} : { extraFiles: opts.extraFiles }),
  })
}

/**
 * What an Apply would carry right now, WITHOUT publishing anything.
 *
 * The read half of `runApply`, and literally the same `currentChanges()` the
 * write half uses — which is the whole point of exporting it rather than
 * rebuilding the comparison somewhere else. A preview that could disagree with
 * the Apply it previews would be worse than no preview.
 *
 * Nothing here takes the lock or starts anything: two callers previewing at
 * once is a pair of reads. The MCP `apply.preview` tool's body — how an
 * agent sees what it is about to commit to before it calls `apply`.
 */
export async function applyPreview(ctx: Pick<Ctx, 'controller'>): Promise<{
  changed: { name: string; fields: string[] }[]
  /** The site-document fields an Apply would write, if any. */
  site: string[]
  /** Why a new Apply would be refused right now, or null. */
  blocked: string | null
}> {
  const [{ changed, site }, blocker] = await Promise.all([currentChanges(), gate.blocked({ ctx })])
  return {
    changed,
    site: [...site.changes],
    blocked: blocker?.reason ?? null,
  }
}
