import { z } from 'zod'
import type { Ctx } from '../../core/ctx'

// The operations tools: the daily report and everything an update takes.
// Registered through server.ts's `read` and `write`, which hold the scope gate.

export type Registrars<R> = {
  read: (
    name: string,
    schema: z.ZodRawShape,
    run: (args: Record<string, unknown>) => Promise<unknown>,
  ) => void
  write: (
    name: string,
    schema: z.ZodRawShape,
    run: (args: Record<string, unknown>, actor: string) => Promise<R>,
  ) => void
  ctx: () => Promise<Ctx>
  ok: (value: unknown) => R
  refuse: (reason: string) => R
}

const hoursArg = {
  hours: z.number().int().min(1).max(168).optional().describe('How far back. Default 24, max 168.'),
}
const hoursOf = (args: Record<string, unknown>) =>
  args.hours === undefined ? 24 : Number(args.hours)
const pinArg = {
  container: z.string().min(1).describe('A container, or a pin id, as updates.pending names it.'),
}

export function registerOpsTools<R>({ read, write, ctx, ok, refuse }: Registrars<R>): void {
  read('report.daily', hoursArg, async (args) => {
    const { dailyReport } = await import('./ops')
    return dailyReport(await ctx(), hoursOf(args))
  })

  read('errors.summary', hoursArg, async (args) => {
    const { errorSummary } = await import('./ops')
    return errorSummary(await ctx(), hoursOf(args))
  })

  read(
    'logs.search',
    {
      container: z.string().min(1).describe('The container.'),
      text: z.string().optional().describe('Text the line holds. Omit for the latest lines.'),
      ...hoursArg,
      limit: z.number().int().min(1).max(200).optional().describe('How many lines. Default 50.'),
    },
    async (args) => {
      const { searchLogs } = await import('./ops')
      return searchLogs(await ctx(), {
        container: String(args.container),
        text: args.text === undefined ? '' : String(args.text),
        hours: hoursOf(args),
        limit: args.limit === undefined ? 50 : Number(args.limit),
      })
    },
  )

  read('alerts.recent', hoursArg, async (args) => {
    const { recentAlerts } = await import('./ops')
    return recentAlerts(await ctx(), hoursOf(args))
  })

  read('jobs.status', {}, async () => {
    const { jobsStatus } = await import('./ops')
    return jobsStatus(await ctx())
  })

  read('health.storage', {}, async () => {
    const { storageHealth } = await import('./ops')
    return storageHealth(await ctx())
  })

  read('updates.pending', {}, async () => {
    const { pendingUpdates } = await import('./ops')
    return pendingUpdates(await ctx())
  })

  read('updates.changelog', pinArg, async (args) => {
    const { changelog } = await import('./ops')
    return changelog(String(args.container))
  })

  read('updates.status', {}, async () => {
    const { updateStatus } = await import('./ops')
    return updateStatus(await ctx())
  })

  read('updates.queue', {}, async () => {
    const { readQueue } = await import('../../core/update-queue')
    return readQueue(await ctx())
  })

  write(
    'updates.queue_add',
    {
      ...pinArg,
      toTag: z.string().optional().describe('Omit to re-resolve the tag this pin is already on.'),
      confirm: z
        .string()
        .optional()
        .describe('The pin name, typed out, for a pin updates.pending lists a ceremony on.'),
    },
    async (args) => {
      const { enqueue } = await import('./ops')
      return ok(
        await enqueue(await ctx(), {
          container: String(args.container),
          toTag: args.toTag === undefined ? null : String(args.toTag),
          typed: args.confirm === undefined ? '' : String(args.confirm),
        }),
      )
    },
  )

  write('updates.queue_remove', pinArg, async (args) => {
    const { unqueueItem } = await import('../../core/update-queue')
    return ok(await unqueueItem(await ctx(), String(args.container)))
  })

  write('updates.queue_clear', {}, async () => {
    const { clearQueue } = await import('../../core/update-queue')
    return ok(await clearQueue(await ctx()))
  })

  write('updates.queue_run', {}, async (_args, actor) => {
    const { runQueue } = await import('./ops')
    const outcome = await runQueue(await ctx(), actor)
    return outcome.ok
      ? ok({ id: outcome.id, targets: outcome.targets })
      : refuse(`${outcome.code}: ${outcome.reason}`)
  })

  write('engine.update', {}, async (_args, actor) => {
    const { runEngineUpdate } = await import('../engine-flow')
    const outcome = await runEngineUpdate({ ctx: await ctx(), actor })
    return outcome.ok ? ok({ id: outcome.id }) : refuse(`${outcome.code}: ${outcome.reason}`)
  })

  write('claude_code.update', {}, async (_args, actor) => {
    const { runClaudeCodeUpdate } = await import('../claude-code-flow')
    const outcome = await runClaudeCodeUpdate({ ctx: await ctx(), actor })
    return outcome.ok ? ok({ id: outcome.id }) : refuse(`${outcome.code}: ${outcome.reason}`)
  })
}
