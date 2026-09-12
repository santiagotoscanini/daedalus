/**
 * "Is this a plain object I can read keys off?" — the guard five modules had
 * each written for themselves.
 *
 * Arrays are excluded deliberately: every caller goes on to read named keys,
 * and an array satisfies `typeof v === 'object'` while answering `undefined`
 * for all of them. The copy in core/builds/report.ts was missing that clause,
 * so the same-named guard meant two things in one codebase.
 */
export const isRecord = (v: unknown): v is Record<string, unknown> =>
  v !== null && typeof v === 'object' && !Array.isArray(v)
