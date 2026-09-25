import { swrCache } from '../../lib/cache'
import { getJsonResult } from '../../lib/http'
import type { RosterPlayer } from '../../lib/module-switch'
import type { Ctx } from '../ctx'
import { saveSiteEdit, siteEdit } from './index'

// A game server's roster, edited from its page.
//
// site.json `modules.players.<id>` is the whole list — who may join and who
// may run commands — and platform/site.nix hands it to the stack as
// `fleet.site.players.<id>`. Like every site edit it goes to the draft and
// lands on the next Apply; how the running server takes it is the stack's
// business (the Minecraft stack reloads its whitelist in place, so an Apply
// kicks nobody who stays on the list).
//
// What this file adds is the vendor: a name is never written until the
// vendor has said which account it is, and the entry carries the vendor's
// id for it. So a typo is refused here with a sentence, rather than reaching
// a server that looks it up at start and dies of it — the way this box's
// Minecraft server once spent an hour green and dead.

/** The modules with a roster, and the vendor each resolves names against. */
const VENDORS = {
  minecraft: { lookup: lookupMojang, label: 'Java account' },
} as const

export type RosterModule = keyof typeof VENDORS

export const isRosterModule = (id: string): id is RosterModule => id in VENDORS

/** Mojang's own rule for a Java name, and fleet.site.players' check on it. */
const NAME = /^[A-Za-z0-9_]{1,16}$/

/** 32 hex digits → the dashed, lower-case form the document and servers use. */
function dashed(id: string): string {
  const h = id.toLowerCase()
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

export type Lookup =
  | { ok: true; player: { name: string; uuid: string } }
  | { ok: false; reason: string }

/**
 * A name → the account Mojang says it is, with the spelling Mojang keeps.
 * A 404 is an answer ("no such account"); anything else unanswered is
 * "could not ask", and never read as either.
 */
async function lookupMojang(name: string): Promise<Lookup> {
  const r = await getJsonResult<{ id?: string; name?: string }>(
    `https://api.mojang.com/users/profiles/minecraft/${encodeURIComponent(name)}`,
  )
  if (!r.ok) {
    return r.reason.status === 404 || r.reason.status === 204
      ? { ok: false, reason: `no Java account is called ${name}` }
      : { ok: false, reason: 'Mojang did not answer — try again in a moment' }
  }
  const { id, name: canonical } = r.value
  if (typeof id !== 'string' || !/^[0-9a-f]{32}$/i.test(id) || typeof canonical !== 'string') {
    return { ok: false, reason: 'Mojang answered with something that is not an account' }
  }
  return { ok: true, player: { name: canonical, uuid: dashed(id) } }
}

export async function lookupPlayer(id: RosterModule, raw: string): Promise<Lookup> {
  const name = raw.trim()
  if (!NAME.test(name)) {
    return { ok: false, reason: 'a Java name is 1–16 letters, digits or underscores' }
  }
  return VENDORS[id].lookup(name)
}

/** The roster as committed, and as the next Apply would write it. */
export async function roster(
  ctx: Ctx,
  id: RosterModule,
): Promise<{ committed: RosterPlayer[]; desired: RosterPlayer[] }> {
  const edit = await siteEdit(ctx)
  return {
    committed: edit.committed?.modules.players[id] ?? [],
    desired: edit.desired.modules.players[id] ?? [],
  }
}

type Outcome = { ok: true; player?: RosterPlayer } | { ok: false; reason: string }

async function writeRoster(ctx: Ctx, id: RosterModule, next: RosterPlayer[]): Promise<void> {
  const edit = await siteEdit(ctx)
  const players = { ...edit.desired.modules.players }
  if (next.length === 0) delete players[id]
  else players[id] = next
  await saveSiteEdit(ctx, { 'modules.players': players })
}

/** Resolve a name and put the account on the draft roster. */
export async function addPlayer(
  ctx: Ctx,
  id: RosterModule,
  name: string,
  op: boolean,
): Promise<Outcome> {
  const found = await lookupPlayer(id, name)
  if (!found.ok) return found
  const { desired } = await roster(ctx, id)
  if (desired.some((p) => p.uuid === found.player.uuid)) {
    return { ok: false, reason: `${found.player.name} is already on the list` }
  }
  const player = { ...found.player, op }
  await writeRoster(ctx, id, [...desired, player])
  return { ok: true, player }
}

export async function removePlayer(ctx: Ctx, id: RosterModule, uuid: string): Promise<Outcome> {
  const { desired } = await roster(ctx, id)
  if (!desired.some((p) => p.uuid === uuid)) return { ok: false, reason: 'not on the list' }
  await writeRoster(
    ctx,
    id,
    desired.filter((p) => p.uuid !== uuid),
  )
  return { ok: true }
}

export async function setPlayerOp(
  ctx: Ctx,
  id: RosterModule,
  uuid: string,
  op: boolean,
): Promise<Outcome> {
  const { desired } = await roster(ctx, id)
  if (!desired.some((p) => p.uuid === uuid)) return { ok: false, reason: 'not on the list' }
  await writeRoster(
    ctx,
    id,
    desired.map((p) => (p.uuid === uuid ? { ...p, op } : p)),
  )
  return { ok: true }
}

// ── what the vendor says about an account ─────────────────────────────────
//
// For the page, never for the document: the name Mojang has for the uuid
// now (a rename shows as one, and the server admits on the uuid regardless),
// the skin's arm model, whether a cape is worn, and the face. Cached for
// hours — skins and names move rarely, and Mojang's session server rations
// profile reads per address.

export type Profile = {
  /** Mojang's current name for the uuid; null when it could not be asked. */
  name: string | null
  model: 'slim' | 'classic' | null
  cape: boolean
  /** The face as a data: URL, so the browser asks no third party for it. */
  head: string | null
}

const profiles = swrCache({ ttlMs: 6 * 60 * 60_000, retryMs: 5 * 60_000 })

export function profileOf(uuid: string): Promise<Profile | null> {
  return profiles.get(`mc:${uuid}`, () => loadProfile(uuid))
}

async function loadProfile(uuid: string): Promise<Profile | null> {
  const bare = uuid.replaceAll('-', '')
  const [session, head] = await Promise.all([
    getJsonResult<{ name?: string; properties?: { name?: string; value?: string }[] }>(
      `https://sessionserver.mojang.com/session/minecraft/profile/${bare}`,
    ),
    faceOf(uuid),
  ])
  if (!session.ok && head === null) return null
  let model: Profile['model'] = null
  let cape = false
  const textures = session.ok
    ? session.value.properties?.find((p) => p.name === 'textures')?.value
    : undefined
  if (textures !== undefined) {
    try {
      const t = JSON.parse(Buffer.from(textures, 'base64').toString('utf8')) as {
        textures?: { SKIN?: { metadata?: { model?: string } }; CAPE?: unknown }
      }
      model =
        t.textures?.SKIN === undefined
          ? null
          : t.textures.SKIN.metadata?.model === 'slim'
            ? 'slim'
            : 'classic'
      cape = t.textures?.CAPE !== undefined
    } catch {
      // A textures blob that does not parse costs the model and the cape, not the row.
    }
  }
  return {
    name: session.ok && typeof session.value.name === 'string' ? session.value.name : null,
    model,
    cape,
    head,
  }
}

/** The face at 32 px, from crafthead (which renders it from Mojang's skin), or null. */
async function faceOf(uuid: string): Promise<string | null> {
  try {
    const res = await fetch(`https://crafthead.net/avatar/${uuid.replaceAll('-', '')}/32`, {
      signal: AbortSignal.timeout(4_000),
    })
    const type = res.headers.get('content-type') ?? ''
    if (!res.ok || !type.startsWith('image/png')) return null
    const bytes = Buffer.from(await res.arrayBuffer())
    return bytes.length > 64_000 ? null : `data:image/png;base64,${bytes.toString('base64')}`
  } catch {
    return null
  }
}
