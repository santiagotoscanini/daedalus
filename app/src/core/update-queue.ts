import { SETTING_KEYS } from '../lib/repo/settings'
import { isQueue, type QueueItem, withItem, withoutItem } from '../lib/update-queue'
import type { Ctx } from './ctx'

// The queue, kept in one settings row. The server functions and the MCP tools
// both come through here, so a pin queued from either is on the other's list.

type Store = Pick<Ctx, 'store'>

export const readQueue = async (ctx: Store): Promise<QueueItem[]> =>
  (await ctx.store.read(SETTING_KEYS.updateQueue, isQueue)) ?? []

async function save(ctx: Store, queue: QueueItem[]): Promise<QueueItem[]> {
  if (queue.length === 0) await ctx.store.delete(SETTING_KEYS.updateQueue)
  else await ctx.store.write(SETTING_KEYS.updateQueue, queue)
  return queue
}

export const queueItem = async (ctx: Store, item: QueueItem): Promise<QueueItem[]> =>
  save(ctx, withItem(await readQueue(ctx), item))

export const unqueueItem = async (ctx: Store, container: string): Promise<QueueItem[]> =>
  save(ctx, withoutItem(await readQueue(ctx), container))

export const clearQueue = (ctx: Store): Promise<QueueItem[]> => save(ctx, [])
