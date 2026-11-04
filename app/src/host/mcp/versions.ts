import type { Ctx } from '../../core/ctx'
import type { FactorioOption } from '../../modules/gaming/data/factorio'
import type { VersionOption } from '../../modules/gaming/data/minecraft-update'

// The game servers' versions, as two MCP tools: what each pins and where it can
// move (the Gaming tabs' own loaders, trimmed), and the move itself (the same
// `runVersionUpdate` the tabs' buttons call).

/** The games whose version daedalus moves: their fleet.versionPins ids, which are also their module ids. */
export const GAMES = ['factorio', 'minecraft'] as const
export type Game = (typeof GAMES)[number]

/** What a game can move to, flattened to the one shape both tools speak. */
type Move = { version: string; build: string | null; channel: string; note: string | null }

const factorioMove = (o: FactorioOption): Move => ({
  version: o.version,
  build: null,
  channel: o.channel,
  note: o.channel === 'experimental' ? 'clients on stable cannot join' : null,
})

const minecraftMove = (o: VersionOption): Move => ({
  version: o.version,
  build: o.build,
  channel: o.channel.toLowerCase(),
  note:
    [o.newGame ? 'new game: converts the world one way' : null, o.preRelease ? 'pre-release' : null]
      .filter((s) => s !== null)
      .join('; ') || null,
})

async function factorioState(ctx: Ctx) {
  const { loadFactorio } = await import('../../modules/gaming/data/factorio')
  const d = await loadFactorio(ctx)
  return {
    pinned: { version: d.factorio.installed, build: null },
    latest: { stable: d.factorio.stable, experimental: d.factorio.experimental },
    gameRunning: d.live.game === null ? null : d.live.game === 'running',
    moves: d.options.map(factorioMove),
    notes: d.changelog,
  }
}

async function minecraftState(ctx: Ctx) {
  const { loadMinecraft } = await import('../../modules/gaming/data/minecraft')
  const d = await loadMinecraft(ctx)
  return {
    pinned: { version: d.minecraft.version, build: d.minecraft.build },
    latest: { mojang: d.minecraft.latestVersion },
    playersOnline: d.minecraft.players,
    moves: d.update.options.map(minecraftMove),
    notes: d.update.notes,
  }
}

const stateOf = (ctx: Ctx, game: Game) =>
  game === 'factorio' ? factorioState(ctx) : minecraftState(ctx)

/** Every enabled game: its pin, where it can move, and the notes in between. */
export async function gameVersions(ctx: Ctx) {
  const { untrusted } = await import('./ops')
  const { readVersionUpdateStatus } = await import('../version-update')
  const games = GAMES.filter((g) => ctx.modules.enabled(g))
  const [states, status] = await Promise.all([
    Promise.all(games.map(async (g) => [g, await stateOf(ctx, g)] as const)),
    readVersionUpdateStatus(ctx),
  ])
  return {
    games: Object.fromEntries(
      states.map(([g, { notes, ...rest }]) => [g, { ...rest, notes: untrusted(notes) }]),
    ),
    lastUpdate: status,
  }
}

/**
 * The move a request names, among the ones offered — or why not. Pure, so the
 * matching is tested apart from the loaders. A Minecraft request that names no
 * build takes the first offered for that version, which is the recommended
 * one (data/minecraft-update.ts sorts them so).
 */
export function pickMove(
  moves: Move[],
  want: { version: string; build: string | null },
): Move | string {
  const found = moves.find(
    (m) => m.version === want.version && (want.build === null || m.build === want.build),
  )
  if (found !== undefined) return found
  if (moves.length === 0) return 'there is nothing newer to move to'
  const offered = moves
    .map((m) => (m.build === null ? m.version : `${m.version} build ${m.build}`))
    .join(', ')
  return `${want.version}${want.build === null ? '' : ` build ${want.build}`} is not one of the offered moves: ${offered}`
}

export type GameUpdateRequest = {
  game: Game
  version: string
  build: string | null
  confirm: string
}

/**
 * Start a version update, or the sentence why not. The confirm is the game's
 * name, always: a move restarts a server players are on, and a newer game
 * converts its world or save one way — the page's typed confirmation, as an
 * argument.
 */
export async function requestGameUpdate(
  ctx: Ctx,
  req: GameUpdateRequest,
  actor: string,
): Promise<
  { ok: true; id: string; values: Record<string, string> } | { ok: false; reason: string }
> {
  if (req.confirm.trim() !== req.game) {
    return {
      ok: false,
      reason: `type the game's name in confirm ("${req.game}"): the update restarts the server, kicking whoever is on it, and a newer version converts the saved world for good`,
    }
  }
  if (!ctx.modules.enabled(req.game)) {
    return { ok: false, reason: `${req.game} is not switched on on this box` }
  }
  const state = await stateOf(ctx, req.game)
  const move = pickMove(state.moves, { version: req.version, build: req.build })
  if (typeof move === 'string') return { ok: false, reason: move }

  const values: Record<string, string> =
    move.build === null ? { version: move.version } : { version: move.version, build: move.build }
  const { runVersionUpdate } = await import('../version-update')
  const outcome = await runVersionUpdate({ ctx, target: req.game, values, actor })
  return outcome.ok
    ? { ok: true, id: outcome.id, values }
    : { ok: false, reason: `${outcome.code}: ${outcome.reason}` }
}
