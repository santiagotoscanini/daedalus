import type { Ctx } from '../core/ctx'
import {
  arrayOf,
  bool,
  type Decoder,
  literal,
  nullable,
  obj,
  optional,
  str,
} from '../lib/contract/decode'
import { defineRootVerb } from './root-verb'

// The app half of an image update: the root helper's `image-update` verb
// (host/root-verb.ts has the mechanics).
//
// Everything privileged happens on the host: `daedalus-image-update@<run>`
// resolves the new digest, rewrites the pin in the flake, commits, and runs
// nixos-rebuild (nix/stacks/daedalus/host/image-update.sh). This container
// cannot rebuild anything and holds no credential that would let it.
//
// What crosses is a list of container names and tags, as the payload: the app
// has nothing to render — the host reads the pin out of the nix-generated
// registry, which is also the allowlist.
//
// ── a request carries several containers ──────────────────────────────────
//
// `targets` is the wire form, and one target is just a batch of one. The host
// makes them ONE commit, ONE build and ONE switch, which is the whole reason
// to queue several rather than press the button six times — and also why a
// failure anywhere reverts all of them together. host/image-update.sh has that
// argument in full.

type ImageUpdateState = 'idle' | 'running' | 'done' | 'failed'

/** One container a request names, and where it should go. */
export type ImageTarget = {
  container: string
  /** Absent means "re-resolve the tag it is already on". */
  toTag?: string
}

/** One container this run moves — including lockstep members nobody picked. */
type ImageMove = {
  container: string
  repo: string
  fromTag: string
  fromDigest: string
  toTag: string
  toDigest: string
  /** False when this member was already on the target — reported, not hidden. */
  changed: boolean
}

export type ImageUpdateStatus = {
  id: string | null
  /**
   * Every container the REQUEST named, which is not every container that
   * moves — lockstep members are in `moves` and were nobody's choice.
   */
  targets: string[]
  state: ImageUpdateState
  phase: string
  error: string
  /** Empty until the host has resolved what it intends to do. */
  moves: ImageMove[]
  startedAt: string | null
  finishedAt: string | null
  commit: string | null
}

/** The status file the host agent writes; decoding `{}` is the idle status. */
const IMAGE_STATUS: Decoder<ImageUpdateStatus> = obj({
  id: optional(nullable(str), null),
  targets: optional(arrayOf(str), []),
  state: optional(literal('idle', 'running', 'done', 'failed'), 'idle'),
  phase: optional(str, ''),
  error: optional(str, ''),
  moves: optional(
    arrayOf(
      obj({
        container: str,
        repo: str,
        fromTag: str,
        fromDigest: str,
        toTag: str,
        toDigest: str,
        changed: bool,
      }),
    ),
    [],
  ),
  startedAt: optional(nullable(str), null),
  finishedAt: optional(nullable(str), null),
  commit: optional(nullable(str), null),
})

const verb = defineRootVerb<ImageUpdateStatus>({
  verb: 'image-update',
  status: IMAGE_STATUS,
  ended: (s) =>
    `The host agent ended during "${s.phase}" without reporting a result. ` +
    "The rebuild may or may not have completed — check `journalctl -u 'daedalus-image-update@*'` " +
    'and `git log` in the configuration checkout before retrying.',
})

/**
 * The status, with a run that ended without its last word reported as dead
 * (host/root-verb.ts). The unit's ExecStopPost reaper marks a killed run
 * failed within seconds, but nothing runs it when the box itself goes down
 * mid-run — and because the flow refuses to start while one is running, a
 * status stuck on "running" would disable every Update button.
 *
 * Sanitising here rather than at the call sites, because the status file has
 * several readers (the flow's busy check, the Updates and Minecraft loaders,
 * the status server function) and a rule only some of them applied is a rule
 * that gets it wrong somewhere.
 */
export const readImageUpdateStatus = (ctx: Pick<Ctx, 'controller'>): Promise<ImageUpdateStatus> =>
  verb.readStatus(ctx)

/**
 * Start an update: its id, or why the helper would not start it.
 *
 * `toTag` absent means "re-resolve the tag this container is already on",
 * which is the entire update for a channel pin like `:latest`. For a release
 * pin it is the tag the operator chose off the candidate list after reading
 * what changed.
 */
export function startImageUpdate(
  ctx: Pick<Ctx, 'controller'>,
  input: { targets: ImageTarget[]; actor: string },
) {
  const targets = input.targets.map((t) => ({
    container: t.container,
    ...(t.toTag === undefined ? {} : { toTag: t.toTag }),
  }))
  return verb.start(ctx, JSON.stringify({ targets, actor: input.actor }))
}
