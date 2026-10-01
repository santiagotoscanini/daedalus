import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { Ctx } from '../../core/ctx'
import { MCP_TOOLS, type McpToolSpec, scopeRefusal } from '../../lib/mcp'
import { MCP_DOCS, readMcpDoc } from './docs'
import type { McpIdentity } from './tokens'

// Daedalus's tools, as an MCP server.
//
// ── what this layer is, and what it deliberately is not ───────────────────
//
// It is an ADAPTER. Every tool below calls the same function the corresponding
// page or button calls, and adds nothing: no second query,
// no second validation of what may be built, no second idea of what an Apply
// carries. That is the property that makes a write token defensible — an MCP
// call can do nothing the UI cannot, because it is running the UI's code.
//
// It is NOT a wrapper over the server functions. Those expect to be running
// inside a TanStack request: they read forward-auth headers through
// `getRequestHeader` and gate on `assertAdmin()` (server/fn.ts's `adminFn`),
// and an MCP request carries neither. Calling them
// from here would be asking a session gate to authorise something with no
// session. So the writes reach the flows directly and bring their own actor —
// see `authoriseWrite` below.
//
// ── the scope check ───────────────────────────────────────────────────────
//
// Every tool is registered for every token, so `tools/list` is the same
// catalogue whoever asks and an agent holding a read token can still SEE what
// a write token would reach. The refusal is in the handler, at the top, before
// any work: a read token calling `build.now` gets one sentence and the box
// does nothing. Registering only the permitted half would hide the refusal
// inside "unknown tool", which is the same answer a typo gets.
//
// ── shapes ────────────────────────────────────────────────────────────────
//
// zod is here and nowhere else in this codebase. The SDK types `inputSchema`
// as a zod schema, so a tool's arguments have to be expressed in it; every
// other boundary in the app still uses the hand-rolled decoder in
// `lib/contract/decode.ts`, and should stay that way.

/** Everything a tool call gets to know about its caller. */
type Caller = {
  identity: McpIdentity
  /** The actor a write is recorded under: `mcp:<label>`. */
  actor: string
}

type ToolResult = { content: { type: 'text'; text: string }[]; isError?: boolean }

const ok = (value: unknown): ToolResult => ({
  content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
})

const refuse = (reason: string): ToolResult => ({
  content: [{ type: 'text', text: reason }],
  isError: true,
})

const specOf = (name: string): McpToolSpec => {
  const spec = MCP_TOOLS.find((t) => t.name === name)
  if (spec === undefined) throw new Error(`${name} is not in MCP_TOOLS — add it there first`)
  return spec
}

/**
 * The scope gate, and for a write also the authorization gate.
 *
 * Returns the actor to record, or the refusal to answer with. The
 * `assertMachineActor` call is the ONLY place a token-authenticated caller is
 * authorised to mutate this box: it is a named function in core/authz.ts
 * precisely so the set of machine-authorised call sites is one grep, and it
 * refuses a proof that is not a live write token rather than trusting this
 * file to have checked.
 */
async function authoriseWrite(
  caller: Caller,
  tool: string,
): Promise<{ ok: true; actor: string } | { ok: false; result: ToolResult }> {
  if (caller.identity.scope !== 'write') {
    return { ok: false, result: refuse(scopeRefusal(tool)) }
  }
  const { assertMachineActor } = await import('../../core/authz')
  try {
    return {
      ok: true,
      actor: assertMachineActor({
        door: 'mcp-token',
        label: caller.identity.label,
        scope: caller.identity.scope,
      }),
    }
  } catch (err) {
    return { ok: false, result: refuse(err instanceof Error ? err.message : 'refused') }
  }
}

/** A tool body, with the boilerplate an unexpected throw would otherwise skip. */
const guarded =
  <A>(run: (args: A) => Promise<ToolResult>) =>
  async (args: A): Promise<ToolResult> => {
    try {
      return await run(args)
    } catch (err) {
      // A throw here is a bug or an upstream that went away, and either way the
      // caller wants the sentence rather than a transport-level error it cannot
      // attribute to a tool.
      const reason = err instanceof Error ? err.message : String(err)
      console.warn('[mcp] tool failed:', reason)
      return refuse(reason)
    }
  }

const appArg = { app: z.string().min(1).describe('The app name, as the registry spells it.') }
const limitArg = {
  limit: z.number().int().min(1).max(100).optional().describe('How many rows. Default 25.'),
}

/**
 * Build the server a single request will be answered by.
 *
 * Per request on purpose: the caller's scope and actor are closed over by every
 * handler, so there is no ambient "who is calling" for a concurrent request to
 * read the wrong value of. Registration is a few dozen object literals and
 * costs nothing next to the first database round trip.
 */
export function buildMcpServer(identity: McpIdentity): McpServer {
  const caller: Caller = { identity, actor: `mcp:${identity.label}` }
  // The request's Ctx, built on first use and shared by every tool after it —
  // the same lazy rule as server/fn.ts `context.ctx()`.
  let made: Promise<Ctx> | undefined
  const ctx = (): Promise<Ctx> => {
    made ??= import('../../core/ctx').then((m) => m.makeCtx())
    return made
  }

  const server = new McpServer(
    { name: 'daedalus', version: '1' },
    {
      instructions:
        'The control plane for this NixOS box: its app registry, builds, deploys, image pins ' +
        'and the site document a rebuild reads. Read the `daedalus://docs/architecture` ' +
        'resource before using a write tool. Write tools go through the same bridge verbs and ' +
        'the same guards as the buttons in the web UI, so they can do nothing the UI cannot.',
    },
  )

  const read = (
    name: string,
    inputSchema: z.ZodRawShape,
    run: (args: Record<string, unknown>) => Promise<unknown>,
  ) => {
    const spec = specOf(name)
    server.registerTool(
      name,
      {
        description: spec.summary,
        inputSchema,
        annotations: { readOnlyHint: true, title: spec.summary },
      },
      // biome-ignore lint/suspicious/noExplicitAny: the SDK infers the arg type from the zod shape; this seam is the one place it is erased.
      guarded(async (args: any) => ok(await run(args))) as any,
    )
  }

  const write = (
    name: string,
    inputSchema: z.ZodRawShape,
    run: (args: Record<string, unknown>, actor: string) => Promise<ToolResult>,
  ) => {
    const spec = specOf(name)
    server.registerTool(
      name,
      {
        description: spec.summary,
        inputSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, title: spec.summary },
      },
      // biome-ignore lint/suspicious/noExplicitAny: as above.
      guarded(async (args: any) => {
        const gate = await authoriseWrite(caller, name)
        if (!gate.ok) return gate.result
        return run(args, gate.actor)
        // biome-ignore lint/suspicious/noExplicitAny: as above.
      }) as any,
    )
  }

  // ── reads ───────────────────────────────────────────────────────────────

  read('apps.list', {}, async () => {
    const { loadAppList } = await import('../../lib/apps/list')
    return loadAppList(await ctx())
  })

  read('apps.get', appArg, async (args) => {
    const { loadAppDetail } = await import('../../lib/apps/detail')
    const detail = await loadAppDetail(await ctx(), { name: String(args.app) })
    if (detail === null) throw new Error(`No app named ${String(args.app)}.`)
    return detail
  })

  read('builds.list', { ...appArg, ...limitArg }, async (args) => {
    const { getApp } = await import('../../lib/repo/apps')
    const { listBuilds } = await import('../../lib/repo/builds')
    const record = await getApp(String(args.app))
    if (!record) throw new Error(`No app named ${String(args.app)}.`)
    return listBuilds(record.id, args.limit === undefined ? 25 : Number(args.limit))
  })

  read('builds.get', { id: z.string().min(1).describe('The build id.') }, async (args) => {
    const { getBuild } = await import('../../lib/repo/builds')
    const row = await getBuild(String(args.id))
    if (row === undefined) throw new Error('No such build.')
    return row
  })

  read(
    'builds.log',
    {
      id: z.string().min(1).describe('The build id.'),
      // Tail-only, and named so: the logs are megabytes and an agent asking for
      // "the log" wants the end of it. A whole-file tool would need
      // lib/builds.ts buildLogPath and a paging story; this is the 95% answer.
      maxBytes: z
        .number()
        .int()
        .min(1)
        .max(1_048_576)
        .optional()
        .describe('How much of the END of the log to read. Default 64000, max 1048576.'),
    },
    async (args) => {
      const { readBuildLogTail } = await import('../build-verb')
      return readBuildLogTail(
        String(args.id),
        args.maxBytes === undefined ? {} : { maxBytes: Number(args.maxBytes) },
      )
    },
  )

  read('deployments', { ...appArg, ...limitArg }, async (args) => {
    const { getApp } = await import('../../lib/repo/apps')
    const { listDeployments } = await import('../../lib/repo/deployments')
    const record = await getApp(String(args.app))
    if (!record) throw new Error(`No app named ${String(args.app)}.`)
    return listDeployments(record.id, args.limit === undefined ? 25 : Number(args.limit))
  })

  read(
    'images.freshness',
    {
      container: z
        .string()
        .optional()
        .describe(
          'One container, or the id of a pinned base. Omit for every digest pin on the box — containers and the bases of the images built on it (these carry pinnedIn, and updatable when image.update can move them).',
        ),
    },
    async (args) => {
      const { imagePins, manualPins } = await import('../contract/domains/images')
      const { imageFreshness } = await import('../../lib/dashboard/images')
      const [containers, manual] = await Promise.all([imagePins(), manualPins()])
      // The probe asks about both under one key space (nix asserts no id is
      // shared), so one lookup serves both.
      const pins: Record<string, unknown> = {
        ...Object.fromEntries(Object.entries(manual).filter(([, m]) => m.digest !== null)),
        ...containers,
      }
      const wanted =
        args.container === undefined
          ? Object.keys(pins)
          : [String(args.container)].filter((c) => c in pins)
      if (args.container !== undefined && wanted.length === 0) {
        throw new Error(`${String(args.container)} has no digest pin — nothing to compare.`)
      }
      return Object.fromEntries(
        await Promise.all(
          wanted.map(async (c) => [c, { pin: pins[c], freshness: await imageFreshness(c) }]),
        ),
      )
    },
  )

  read('dns.records', {}, async () => {
    const { loadDns } = await import('../../modules/network/data/dns')
    return loadDns(await ctx())
  })

  read('site.get', {}, async () => {
    const { siteState, runningSite } = await import('../../core/site')
    const c = await ctx()
    const [state, document] = await Promise.all([siteState(c), runningSite(c)])
    return { state, document }
  })

  read('apply.preview', {}, async () => {
    const { applyPreview } = await import('../apply-flow')
    return applyPreview()
  })

  read('health', {}, async () => {
    const { loadHealth } = await import('../../lib/dashboard/health')
    return loadHealth(await ctx())
  })

  // ── writes ──────────────────────────────────────────────────────────────

  write('build.now', appArg, async (args, actor) => {
    const { buildNow } = await import('../../core/builds/actions')
    const outcome = await buildNow({ app: String(args.app), actor })
    return outcome.ok ? ok(outcome.value) : refuse(outcome.reason)
  })

  write(
    'build.cancel',
    { ...appArg, id: z.string().min(1).describe('The build id.') },
    async (args, actor) => {
      const { cancelBuild } = await import('../../core/builds/actions')
      const outcome = await cancelBuild(await ctx(), {
        app: String(args.app),
        id: String(args.id),
        actor,
      })
      return outcome.ok ? ok({ cancelled: String(args.id) }) : refuse(outcome.reason)
    },
  )

  write('deploy.trigger', appArg, async (args, actor) => {
    const { requestManualDeploy } = await import('../../lib/apps/deploy')
    // Answers when the deploy unit has finished: its last line on success,
    // its reason otherwise (already running, a failed pull).
    const answer = await requestManualDeploy(await ctx(), String(args.app), actor)
    return answer.outcome === 'done'
      ? ok({ deployed: String(args.app), detail: answer.detail })
      : refuse(`the deploy ${answer.outcome}: ${answer.detail}`)
  })

  write(
    'image.update',
    {
      targets: z
        .array(
          z.object({
            container: z.string().min(1),
            toTag: z
              .string()
              .optional()
              .describe('Omit to re-resolve the tag this container is already on.'),
          }),
        )
        .min(1)
        .describe(
          'One or more pins to move, each by the name its System › Updates row shows: a container, or the id of a base the configuration pins (e.g. the one a locally built image is built FROM). Several become ONE commit, build and switch.',
        ),
      confirm: z
        .string()
        .optional()
        .describe(
          'The pin name, typed out. Required for a pin whose fleet.imageUpdates entry declares a ceremony, or a majorCeremony and the move is to a new major.',
        ),
    },
    async (args, actor) => {
      const targets = args.targets as { container: string; toTag?: string }[]
      const confirm = args.confirm as string | undefined

      // The ceremony gate (lib/image-ceremony.ts) is runImageUpdate's, shared
      // with the Updates panel: an agent is exactly the caller it exists for.
      const { runImageUpdate } = await import('../update-flow')
      const outcome = await runImageUpdate({
        targets: targets.map((t) => ({
          container: t.container,
          ...(t.toTag === undefined ? {} : { toTag: t.toTag }),
        })),
        confirm: confirm === undefined ? [] : [confirm],
        actor,
      })
      return outcome.ok
        ? ok({ id: outcome.id, targets: outcome.targets })
        : refuse(`${outcome.code}: ${outcome.reason}`)
    },
  )

  write('apply', {}, async (_args, actor) => {
    const { runApply } = await import('../apply-flow')
    const outcome = await runApply(actor)
    return outcome.ok
      ? ok({ id: outcome.id, changed: outcome.changed })
      : refuse(`${outcome.code}: ${outcome.reason}`)
  })

  // ── resources ───────────────────────────────────────────────────────────

  for (const doc of MCP_DOCS) {
    server.registerResource(
      doc.name,
      doc.uri,
      { title: doc.title, description: doc.description, mimeType: 'text/markdown' },
      async () => ({
        contents: [{ uri: doc.uri, mimeType: 'text/markdown', text: await readMcpDoc(doc) }],
      }),
    )
  }

  return server
}
