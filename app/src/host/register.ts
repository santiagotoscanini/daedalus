import type { Ctx } from '../core/ctx'
import { type Decoder, literal, nullable, obj, optional, str } from '../lib/contract/decode'
import { defineRootVerb } from './root-verb'

// The app half of `register`: the root helper's verb that commits apps.json
// entries awaiting their first image, without a rebuild
// (nix/stacks/daedalus/host/register.sh, which holds every rule it applies).
// lib/apps/setup.ts decides what to register; this only starts it and reads
// how it went.

export type RegisterStatus = {
  id: string | null
  state: 'idle' | 'running' | 'done' | 'failed'
  phase: string
  error: string
  commit: string | null
}

const REGISTER_STATUS: Decoder<RegisterStatus> = obj({
  id: optional(nullable(str), null),
  state: optional(literal('idle', 'running', 'done', 'failed'), 'idle'),
  phase: optional(str, ''),
  error: optional(str, ''),
  commit: optional(nullable(str), null),
})

const verb = defineRootVerb<RegisterStatus>({
  verb: 'register',
  status: REGISTER_STATUS,
  ended: (s) =>
    `The host agent ended during "${s.phase}" without reporting a result. ` +
    "Check `journalctl -u 'daedalus-register@*'` and `git status` in the configuration checkout.",
})

export const readRegisterStatus = (ctx: Pick<Ctx, 'controller'>): Promise<RegisterStatus> =>
  verb.readStatus(ctx)

/** Start a register run with the rendered apps.json; its id, or why it did not start. */
export function startRegister(
  ctx: Pick<Ctx, 'controller'>,
  input: { appsJson: string; summary: string; actor: string; commit: boolean },
) {
  return verb.start(
    ctx,
    JSON.stringify({
      actor: input.actor,
      summary: input.summary,
      commit: input.commit,
      files: { 'apps.json': input.appsJson },
    }),
  )
}
