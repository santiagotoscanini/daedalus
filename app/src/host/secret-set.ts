import { Buffer } from 'node:buffer'
import type { ControllerClient } from './controller/client'
import { type RootAnswer, rootActor, runRoot } from './root'

// Asking the host to set or remove ONE key in an app's operator-secrets file
// (site/vault/apps/<app>-env.sops): the root helper's `secret-set` verb
// (nix/stacks/daedalus/daedalus-verbs.nix, host/secret-set.sh), through the
// controller (host/root.ts). The answer is the unit's last line — what it
// wrote and the commit, or why it refused.
//
// WHAT CROSSES, AND WHAT CANNOT. The container seals the value first
// (lib/apps/secrets.ts → core/vault.ts's encrypt-only sops) and sends the
// CIPHERTEXT as the verb's payload — a whole sops document for one value,
// sealed to the same recipients as the file it is destined for. The helper
// puts it in the unit's run file (root's, 0600, on tmpfs), never on a command
// line or in a unit name, and logs only its size.
//
// The host decrypts it in memory, merges the one key with `sops set`, and
// commits naming the KEY only. It can do that and the container cannot,
// because the host has the age identity and the container has never had one.
//
// WHY ONE KEY AND NOT A FILE. The container cannot re-emit the file: reading
// the other keys back would need the decryption key it deliberately lacks. A
// whole-file write would therefore mean "replace everything with what I can
// see", which is every other secret gone. One key, merged host-side, is the
// only shape this identity can express — and it happens to be the shape with
// the smallest blast radius anyway.
//
// The selectors are an app NAME (one of the applied registry's, the verb's
// list: verbs-lib.nix `secretApps`) and a key NAME (the verb's `key` pattern),
// never a path.

/** The unit's own two minutes and the start job's minute (the verb's timeoutSec), and a little more. */
const SECRET_WAIT_MS = 200_000

/**
 * The largest sealed document the verb takes (its payloadMax in
 * daedalus-verbs.nix): a larger one is refused here, in a sentence, before a
 * connection is spent on it.
 */
export const SECRET_PAYLOAD_MAX = 65_536

/**
 * Ask for a set. `ciphertext` is a sops document, never a value — callers get
 * one from `sealAppSecret` and have no other way to make one.
 */
export async function requestSecretSet(
  input: { actor: string; app: string; key: string; ciphertext: string },
  client?: ControllerClient,
): Promise<RootAnswer> {
  if (Buffer.byteLength(input.ciphertext) > SECRET_PAYLOAD_MAX) {
    return {
      outcome: 'refused',
      detail: `Nothing was sent: the sealed value is over ${SECRET_PAYLOAD_MAX / 1024} KiB. Shorten the value.`,
    }
  }
  return runRoot(
    'secret-set',
    { app: input.app, action: 'set', key: input.key, actor: rootActor(input.actor) },
    SECRET_WAIT_MS,
    client,
    input.ciphertext,
  )
}

/** Ask for a remove. Nothing is sealed: there is no value to send. */
export async function requestSecretRemove(
  input: { actor: string; app: string; key: string },
  client?: ControllerClient,
): Promise<RootAnswer> {
  return runRoot(
    'secret-set',
    { app: input.app, action: 'remove', key: input.key, actor: rootActor(input.actor) },
    SECRET_WAIT_MS,
    client,
  )
}
