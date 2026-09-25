import { createServerFn } from '@tanstack/react-start'
import { isRecord } from '../lib/is-record'

// The server functions behind a game server's roster (core/site/players.ts).
// Every write is a site edit and lands on the next Apply; nothing here
// rebuilds.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

function moduleOf(d: Record<string, unknown>): string {
  if (typeof d.id !== 'string' || d.id === '') throw new Error('expected a module id')
  return d.id
}

async function rosterModule(id: string) {
  const { isRosterModule } = await import('../core/site/players')
  if (!isRosterModule(id)) throw new Error(`${id} keeps no roster`)
  return id
}

/** What the vendor says a name is — a preview, written nowhere. */
export const lookupPlayerFn = createServerFn()
  .validator((data: unknown): { id: string; name: string } => {
    if (!isRecord(data) || typeof data.name !== 'string') throw new Error('expected { id, name }')
    return { id: moduleOf(data), name: data.name }
  })
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { lookupPlayer } = await import('../core/site/players')
    return lookupPlayer(await rosterModule(data.id), data.name)
  })

export const addPlayerFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { id: string; name: string; op: boolean } => {
    if (!isRecord(data) || typeof data.name !== 'string') {
      throw new Error('expected { id, name, op? }')
    }
    return { id: moduleOf(data), name: data.name, op: data.op === true }
  })
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { addPlayer } = await import('../core/site/players')
    return addPlayer(await makeCtx(), await rosterModule(data.id), data.name, data.op)
  })

export const removePlayerFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { id: string; uuid: string } => {
    if (!isRecord(data) || typeof data.uuid !== 'string' || !UUID.test(data.uuid)) {
      throw new Error('expected { id, uuid }')
    }
    return { id: moduleOf(data), uuid: data.uuid }
  })
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { removePlayer } = await import('../core/site/players')
    return removePlayer(await makeCtx(), await rosterModule(data.id), data.uuid)
  })

export const setPlayerOpFn = createServerFn({ method: 'POST' })
  .validator((data: unknown): { id: string; uuid: string; op: boolean } => {
    if (
      !isRecord(data) ||
      typeof data.uuid !== 'string' ||
      !UUID.test(data.uuid) ||
      typeof data.op !== 'boolean'
    ) {
      throw new Error('expected { id, uuid, op }')
    }
    return { id: moduleOf(data), uuid: data.uuid, op: data.op }
  })
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { makeCtx } = await import('../core/ctx')
    const { setPlayerOp } = await import('../core/site/players')
    return setPlayerOp(await makeCtx(), await rosterModule(data.id), data.uuid, data.op)
  })
