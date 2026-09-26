import { secretKeyError } from '../apps/secret-keys'
import { isAppName } from '../hostname'
import { isRecord } from '../is-record'
import { isModuleId } from '../modules/registry'
import { isTaskId } from '../tasks'
import { DecodeError, type Decoder, is, obj, optional, str, withMessage } from './decode'

// Field decoders more than one server function reads (src/server/**), each
// refusing with the sentence the hand-written check it replaced used — those
// reach the page as the error text, so the wording is part of the contract.
//
// Pure, and only ever named inside a `.validator(...)`, which the Start
// compiler erases from the browser's copy of a server-function file.

// ── Plain shapes ─────────────────────────────────────────────────────────

/** A plain object — lib/is-record's rule, arrays excluded — passed on as it is. */
export const recordField: Decoder<Record<string, unknown>> = is(isRecord, 'an object')

/** A string that is not empty. */
export const nonEmptyStringField: Decoder<string> = is(
  (v: unknown): v is string => typeof v === 'string' && v !== '',
  'a non-empty string',
)

/** A string with something in it besides whitespace, handed back untrimmed. */
export function nonBlankField(message: string): Decoder<string> {
  return (v) => {
    if (typeof v !== 'string' || v.trim() === '') throw new Error(message)
    return v
  }
}

/**
 * A string of at most `max` characters — the `typeof v === 'string' &&
 * v.length <= max` check those validators each wrote. Refuses with a
 * DecodeError, so a `withMessage` around it supplies the sentence the page
 * shows (the messages name the field, never its value).
 */
export function strMax(max: number): Decoder<string> {
  return (v, p) => {
    if (typeof v !== 'string') throw new DecodeError(p, 'expected a string')
    if (v.length > max) throw new DecodeError(p, `expected at most ${String(max)} characters`)
    return v
  }
}

/** An opt-in switch: exactly `true` is on, anything else — absent included — is off. */
export const flagField: Decoder<boolean> = (v) => v === true

/**
 * A map of string values, copied key by key into a fresh object; a non-string
 * value is refused as `<key> must be a string`.
 */
export const stringMapField: Decoder<Record<string, string>> = (v, p) => {
  if (!isRecord(v)) throw new DecodeError(p, 'expected an object')
  const out: Record<string, string> = {}
  for (const [k, x] of Object.entries(v)) {
    if (typeof x !== 'string') throw new Error(`${k} must be a string`)
    out[k] = x
  }
  return out
}

/**
 * A page size: a whole number clamped to `[1, max]`, and anything else —
 * absent, fractional, not a number — the fallback. Never refuses.
 */
export const pageSizeField =
  (max: number, fallback: number): Decoder<number> =>
  (v) =>
    typeof v === 'number' && Number.isInteger(v) ? Math.min(max, Math.max(1, v)) : fallback

// ── Names of things the dashboard knows ─────────────────────────────────

/** An app's name (lib/hostname.ts `isAppName`). */
export const appNameField: Decoder<string> = withMessage(
  is(isAppName, 'an app name'),
  'expected an app name',
)

/** A module id this dashboard has (lib/modules/registry.ts). */
export const moduleIdField: Decoder<string> = withMessage(
  is(isModuleId, 'a module id'),
  'expected a module',
)

/** A scheduled task's id (lib/tasks.ts `isTaskId`). */
export const taskIdField: Decoder<string> = withMessage(
  is(isTaskId, 'a task id'),
  'expected a task id',
)

const NODE_ID = /^[0-9a-f]{16}$/

/** A node's id as the agent mints it: 16 lowercase hex digits. */
export const nodeIdField: Decoder<string> = withMessage(
  is((v: unknown): v is string => typeof v === 'string' && NODE_ID.test(v), 'a node id'),
  'expected a node id',
)

/**
 * An app-secret variable name, refused with lib/apps/secret-keys.ts's own
 * sentence — a plain Error, so an outer `withMessage` lets it through.
 */
export const secretKeyField: Decoder<string> = (v) => {
  const bad = secretKeyError(v)
  if (bad !== null) throw new Error(bad)
  return v as string
}

// ── Container images ─────────────────────────────────────────────────────

/**
 * A container name, as a request may carry one: a non-empty string.
 *
 * Deliberately a shape check rather than an allowlist: what the containers on
 * this box are called is the nix-rendered pin registry's answer, and the host
 * checks every target against it (stacks/daedalus/host/image-update.sh). What
 * belongs here is that a name is a string at all — everything downstream,
 * including a `jq` expression in a shell script, has been assuming it.
 *
 * `what` names the field in the refusal: "<what> must be a container name".
 */
export const containerNameField = (what: string): Decoder<string> =>
  withMessage(nonEmptyStringField, `${what} must be a container name`)

const imageTargetShape = withMessage(
  obj({
    container: containerNameField('each target'),
    toTag: withMessage(
      optional<string | undefined>(str, undefined),
      'toTag must be a string when present',
    ),
  }),
  'each target must name a container',
)

/**
 * One pin to move: a container, and the tag to move it to when named. An
 * absent `toTag` is absent from the result too, not a key holding undefined.
 */
export const imageTargetField: Decoder<{ container: string; toTag?: string }> = (v, p) => {
  const { container, toTag } = imageTargetShape(v, p)
  return toTag === undefined ? { container } : { container, toTag }
}
