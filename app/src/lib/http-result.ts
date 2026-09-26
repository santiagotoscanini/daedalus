import { isRecord } from './is-record'
import type { Result } from './result'

/**
 * A request's JSON body, if it is an object.
 *
 * `null` is valid JSON: the parse succeeds, a catch never fires, and a cast to
 * a record would leave the first property read to throw outside the try — a
 * 500 where a 400 is meant. The two failures stay apart because the routes
 * word them differently, and their wording is wire format.
 */
export async function readJsonObject(
  request: Request,
): Promise<Result<Record<string, unknown>, 'not-json' | 'not-object'>> {
  let parsed: unknown
  try {
    parsed = await request.json()
  } catch {
    return { ok: false, reason: 'not-json' }
  }
  return isRecord(parsed) ? { ok: true, value: parsed } : { ok: false, reason: 'not-object' }
}
