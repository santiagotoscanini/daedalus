/**
 * "Is this a plain object I can read keys off?" — one shared guard, so the
 * name means one thing everywhere.
 *
 * Arrays are excluded deliberately: every caller goes on to read named keys,
 * and an array satisfies `typeof v === 'object'` while answering `undefined`
 * for all of them.
 */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
