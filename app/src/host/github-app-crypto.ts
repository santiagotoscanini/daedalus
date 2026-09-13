import { createHmac, timingSafeEqual } from 'node:crypto'

// The two comparisons that stand in front of unauthenticated paths: the deploy
// hook's shared token and GitHub's webhook signature. Server-side only (it
// needs node:crypto), but a plain module so both are table-testable.

/**
 * Constant-time compare. `===` on a secret leaks its length and prefix through
 * timing; irrelevant over a LAN in practice, but these credentials stand in
 * front of unauthenticated paths that start privileged units.
 */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

const PREFIX = 'sha256='
const HEX = /^[0-9a-f]+$/i

/**
 * GitHub's `X-Hub-Signature-256`: HMAC-SHA256 of the raw body, hex, prefixed
 * `sha256=`. The body must be the exact bytes received, so only bytes are
 * accepted (the route streams the body into a capped `Uint8Array`): a string has already been
 * decoded, and a re-serialised JSON object never matches.
 *
 * A blank secret is refused rather than verified: HMAC with an empty key is a
 * signature anyone can compute. So is one with surrounding whitespace — that is
 * a paste that kept its newline, never the secret GitHub signs with.
 */
export function verifyWebhookSignature(
  rawBody: Uint8Array,
  header: string | null,
  secret: string,
): boolean {
  if (!(rawBody instanceof Uint8Array)) return false
  if (secret.trim() === '' || secret !== secret.trim()) return false
  if (header === null || !header.startsWith(PREFIX)) return false
  const hex = header.slice(PREFIX.length)
  // Buffer.from(hex, 'hex') stops silently at the first non-hex character, so
  // a malformed header must be refused before it is decoded.
  if (!HEX.test(hex) || hex.length % 2 !== 0) return false
  const received = Buffer.from(hex, 'hex')
  const expected = createHmac('sha256', secret).update(rawBody).digest()
  if (received.length !== expected.length) return false
  return timingSafeEqual(received, expected)
}
