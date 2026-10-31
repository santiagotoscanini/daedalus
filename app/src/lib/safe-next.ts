/**
 * An app-relative path to return to after signing in, or `/`. Never another
 * origin: `//host` and `/\host` are both absolute to a browser.
 */
export function safeNext(next: string | null | undefined): string {
  if (next === null || next === undefined) return '/'
  return /^\/(?![/\\])/.test(next) && !next.includes('\\') ? next : '/'
}
