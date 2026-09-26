import { secretKeyError } from '../apps/secret-keys'
import { isRecord } from '../is-record'
import { isTaskId } from '../tasks'
import { DecodeError, type Decoder, is, withMessage } from './decode'

// More field decoders for server-function inputs (see fields.ts, which this
// sits beside until the two are merged). Each refuses with the sentence the
// hand-written check it replaced used.

/** A plain object — lib/is-record's rule, arrays excluded — passed on as it is. */
export const recordField: Decoder<Record<string, unknown>> = is(isRecord, 'an object')

/** A string that is not empty. */
export const nonEmptyStringField: Decoder<string> = is(
  (v: unknown): v is string => typeof v === 'string' && v !== '',
  'a non-empty string',
)

/** A scheduled task's id (lib/tasks.ts `isTaskId`) — what `taskId(v)` checked. */
export const taskIdField: Decoder<string> = withMessage(
  is(isTaskId, 'a task id'),
  'expected a task id',
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
