import { stripAnsi } from './ansi'

// Two things, because the second needs the first.
//
// `redactSecrets` is the pattern-only secret filter. It was written for build
// logs — the host filters as it writes, and everything leaving this server
// passes through here again — but nothing in it is about builds: every
// pattern recognises a credential by its own shape, so the same function is
// what makes any untrusted text safe to show. It lives here rather than in
// lib/builds.ts so that a component can reach it without dragging the build
// contract into its chunk.
//
// `errorText` turns an `unknown` from a `catch` into a sentence a person may
// be shown. Prefer it to a bare `e instanceof Error ? e.message : String(e)`,
// which neither redacts nor caps — so the same expression would mean "safe to
// show" in one file and "possibly a secret" in the next.

const REDACTED = '[redacted]'

// A private key block, PEM or PGP armour: BEGIN to END, or to the end of the
// text when END has not been written yet.
const PEM_BLOCK =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----[\s\S]*?(?:-----END [A-Z0-9 ]*-----|$)/g
// A key whose BEGIN line fell before a tail's start: everything up to its END.
const PEM_ORPHAN_END = /^[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----/

// Every pattern runs over a log of up to a MiB on the event loop, so each must
// stay linear on hostile input: it starts at a literal or behind a lookbehind
// that refuses a start inside a run it would rescan, and no two unbounded
// quantifiers in it can trade characters.
const TOKEN_PATTERNS: [RegExp, string][] = [
  [/github_pat_[A-Za-z0-9_]+/g, REDACTED],
  [/gh[opusr]_[A-Za-z0-9_]{20,}/g, REDACTED],
  [/(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]*/g, REDACTED],
  [/x-access-token:[^@\s]+/g, `x-access-token:${REDACTED}`],
  [/x-access-token%3A[^@%\s]+/gi, `x-access-token%3A${REDACTED}`],
  // scheme://user:secret@ — the scheme and user stay. The secret runs to the
  // last @ before a slash or a space, so an unencoded @ in it does not leak.
  [/(?<![A-Za-z0-9+.-])([a-z][a-z0-9+.-]*:\/\/[^\s:@/]*:)[^\s/]+@/gi, `$1${REDACTED}@`],
  // A Docker config.json credential.
  [/("auth"\s*:\s*")[A-Za-z0-9+/=]+"/g, `$1${REDACTED}"`],
  // A header as curl, git and JSON (plain or escaped inside a string) print it.
  [
    /(authorization\\?["']?\s*[:=]\s*(?:\\?["'])?(?:basic|bearer|token)\s+)[^\s"'\\,;]+/gi,
    `$1${REDACTED}`,
  ],
  // An .npmrc registry credential.
  [/(_authToken\s*=\s*["']?)[^\s"']+/gi, `$1${REDACTED}`],
]

/**
 * Credentials out of text this app did not write.
 *
 * The second redaction layer on the build path — the host filters the log as
 * it writes, and everything leaving this server passes through here again —
 * and the only one everywhere else. Patterns only: no knowledge of the real
 * values, so it also catches a token the host never knew it printed.
 *
 * Terminal escapes are stripped first, and stay stripped: a colour code in the
 * middle of a token would otherwise end the pattern's run before the secret
 * does.
 */
export function redactSecrets(text: string): string {
  let out = stripAnsi(text).replace(PEM_BLOCK, REDACTED).replace(PEM_ORPHAN_END, REDACTED)
  for (const [re, replacement] of TOKEN_PATTERNS) out = out.replace(re, replacement)
  return out
}

/**
 * How long a message may be. Long enough for a decoder path plus its
 * complaint, short enough that a stack or a log dump cannot become the page.
 */
const MAX = 300

/**
 * A caught `unknown`, as a sentence a person may be shown.
 *
 * First line only: everything downstream is either a one-line `console.warn`
 * or a single element on a page, and a stack trace in either is noise around
 * the sentence that matters. Redacted because a `catch` here can hold the
 * words of a subprocess, an upstream's body or a git remote — none of which
 * this app chose.
 */
export function errorText(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e)
  return redactSecrets(raw.split('\n')[0] ?? '').slice(0, MAX)
}
