import type { Ctx } from '../core/ctx'
import { type Decoder, literal, nullable, obj, optional, str } from '../lib/contract/decode'
import { defineRootVerb } from './root-verb'

// The app half of moving this box's Claude Code pin: the root helper's
// `claude-code-update` verb (host/root-verb.ts has the mechanics).
//
// The CLI here is a nix package sealed with DISABLE_UPDATES
// (nix/platform/claude-code/claude-code.nix says why), so `claude update` is
// not a path and a flake bump is the only one. The bump starts in the ENGINE —
// its `nix/platform/claude-code/manifest.zst.json` is what the packaged
// expression takes as its manifest — and the host agent
// (nix/stacks/daedalus/host/claude-code-update.sh) does exactly that half:
// fetch the current release, verify the detached signature against
// Anthropic's published key, commit the manifest into the engine clone, push
// it, and then hand the rebuild to the engine-update verb
// (host/engine-update.ts).
//
// That handoff is why `state: 'done'` here does not mean the new CLI is
// installed — it means it is PINNED and the engine update has been asked for.
// The page follows the engine status from there, and the box's own snapshot
// ("what the flake holds") is the answer that settles it.
//
// Nothing to choose: the payload is the actor, and the release to move to is
// whatever upstream calls latest, which is the host's answer, published as
// `to`.

type ClaudeCodeUpdateState = 'idle' | 'running' | 'done' | 'failed'

export type ClaudeCodeUpdateStatus = {
  id: string | null
  state: ClaudeCodeUpdateState
  phase: string
  error: string
  /** The version the engine's manifest pinned when the run started. */
  from: string
  /** The version upstream calls latest. Empty until resolved; equal to `from` on a no-op. */
  to: string
  startedAt: string | null
  finishedAt: string | null
  /** The manifest commit in the engine, short. Empty until committed. */
  commit: string | null
}

/** The status file the host agent writes; decoding `{}` is the idle status. */
const CLAUDE_CODE_STATUS: Decoder<ClaudeCodeUpdateStatus> = obj({
  id: optional(nullable(str), null),
  state: optional(literal('idle', 'running', 'done', 'failed'), 'idle'),
  phase: optional(str, ''),
  error: optional(str, ''),
  from: optional(str, ''),
  to: optional(str, ''),
  startedAt: optional(nullable(str), null),
  finishedAt: optional(nullable(str), null),
  commit: optional(nullable(str), null),
})

const verb = defineRootVerb<ClaudeCodeUpdateStatus>({
  verb: 'claude-code-update',
  status: CLAUDE_CODE_STATUS,
  ended: (s) =>
    `The host agent ended during "${s.phase}" without reporting a result. ` +
    "Check `journalctl -u 'daedalus-claude-code-update@*'` and `git log` in the engine clone " +
    'before retrying.',
})

/** The status, with a run that ended without its last word reported as dead (host/root-verb.ts). */
export const readClaudeCodeUpdateStatus = (
  ctx: Pick<Ctx, 'controller'>,
): Promise<ClaudeCodeUpdateStatus> => verb.readStatus(ctx)

/** Start a pin. Nothing to choose: upstream's latest, or nothing. */
export const startClaudeCodeUpdate = (ctx: Pick<Ctx, 'controller'>, input: { actor: string }) =>
  verb.start(ctx, JSON.stringify({ actor: input.actor }))
