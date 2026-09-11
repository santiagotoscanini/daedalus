// Terminal escape sequences, removed. Pure and client-safe: the check run
// output (lib/github-app.ts) strips them for GitHub, and the build log
// redaction (lib/builds.ts) strips them before matching, so a colour code
// cannot split a token past the patterns.

// Built from char codes so no control character sits in a regex literal.
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const CSI8 = String.fromCharCode(0x9b)
const ANSI = new RegExp(
  [
    `${ESC}\\[[0-?]*[ -/]*[@-~]`, // CSI: colours, cursor moves
    `${CSI8}[0-?]*[ -/]*[@-~]`, // 8-bit CSI
    `${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, // OSC: titles, hyperlinks
    `${ESC}[@-_]`, // any other two-byte escape
  ].join('|'),
  'g',
)

export function stripAnsi(s: string): string {
  return s.replace(ANSI, '')
}
