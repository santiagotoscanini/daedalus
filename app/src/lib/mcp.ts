// The MCP server's vocabulary, as pure data.
//
// Everything here is shared by three places that must agree and are compiled
// into different bundles: the drizzle table (`host/schema.ts`), the server that
// registers the tools (`host/mcp/`), and the Settings › Developer panel that
// mints tokens in the browser. So it holds no `node:` import, no database and
// no `process.env` — the scope vocabulary and the catalogue, nothing else.
//
// WHY A CATALOGUE AT ALL, when the MCP server already registers the tools:
// the panel has to be able to say what a `read` token can do BEFORE one is
// minted, and it cannot import the server to ask. One list, two readers, and
// the test in host/mcp/http.test.ts asserts the registry and this list are
// the same set — so a tool added in one place and forgotten in the other is a
// failing test rather than a panel that quietly lies.

/**
 * What a token may reach.
 *
 * Two values and no more. `read` is every loader the UI renders from; `write`
 * is those plus the five already-fenced mutations. There is deliberately no
 * per-tool scope: the writes all end at the same two bridge verbs and the same
 * rebuild lock, so a token that may start one may start any of them, and
 * pretending otherwise would be a security story the mechanism does not back.
 */
export const MCP_SCOPES = ['read', 'write'] as const
export type McpScope = (typeof MCP_SCOPES)[number]

export function isMcpScope(v: unknown): v is McpScope {
  return typeof v === 'string' && (MCP_SCOPES as readonly string[]).includes(v)
}

/** One tool, as the panel describes it and the server registers it. */
export type McpToolSpec = {
  name: string
  /** The scope a caller needs. `read` tools are reachable by both. */
  scope: McpScope
  /** One line, in the imperative, as the tool's own description. */
  summary: string
}

/**
 * Every tool the server offers.
 *
 * Read tools are the loaders the pages already use — the same function, no
 * second implementation, so an MCP answer and the page it mirrors can never
 * disagree. Write tools are the five doors the UI has, reached through the
 * same `host/` flows the buttons call: an MCP call can do nothing the UI
 * cannot, which is the property that makes a write token defensible at all.
 */
export const MCP_TOOLS: readonly McpToolSpec[] = [
  {
    name: 'apps.list',
    scope: 'read',
    summary: 'List every app in the registry with its live status.',
  },
  {
    name: 'apps.get',
    scope: 'read',
    summary: 'One app: its record, drift from nix, and live signals.',
  },
  { name: 'builds.list', scope: 'read', summary: 'Recent builds of one app, newest first.' },
  {
    name: 'builds.get',
    scope: 'read',
    summary: 'One build by id, with its detection, checks and timings.',
  },
  { name: 'builds.log', scope: 'read', summary: "The tail of a build's log, redacted." },
  { name: 'deployments', scope: 'read', summary: 'Deploy history for one app, newest first.' },
  {
    name: 'images.freshness',
    scope: 'read',
    summary: 'Whether a digest-pinned container is behind its tag.',
  },
  { name: 'dns.records', scope: 'read', summary: 'The resolver, the zone, and every LAN name.' },
  {
    name: 'site.get',
    scope: 'read',
    summary: 'The site document and the state of the files an Apply writes.',
  },
  {
    name: 'apply.preview',
    scope: 'read',
    summary: 'What an Apply would carry right now. Commits nothing.',
  },
  { name: 'health', scope: 'read', summary: 'Every gatus probe, and which of them is failing.' },
  { name: 'build.now', scope: 'write', summary: "Build the tip of an app's default branch now." },
  { name: 'build.cancel', scope: 'write', summary: 'Stop a running build.' },
  {
    name: 'deploy.trigger',
    scope: 'write',
    summary: "Run an app's deploy unit now instead of at its next timer.",
  },
  {
    name: 'image.update',
    scope: 'write',
    summary: 'Move one or more container image pins, then rebuild and switch.',
  },
  {
    name: 'apply',
    scope: 'write',
    summary: 'Write the registry and site files, rebuild, and switch.',
  },
] as const

/** The refusal a read token gets when it calls a write tool. One sentence, everywhere. */
export function scopeRefusal(tool: string): string {
  return `${tool} needs a write token; this token is read-only, so nothing was done.`
}
