import { createServerFn } from '@tanstack/react-start'
import { asValidator, bool, is, obj, str, withMessage } from '../lib/contract/decode'
import { flagField } from '../lib/contract/fields-c'
import { adminFn } from './fn'

// The server functions behind a game server's roster (core/site/players.ts).
// Every write is a site edit and lands on the next Apply; nothing here
// rebuilds.
//
// Each shape below lists its fields in the order the checks run: the
// other fields first, the module id last, so the sentence a bad request
// gets is the one it always got.

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

/** Any non-empty string, untrimmed; whether it names a roster is `rosterModule`'s question. */
const moduleField = withMessage(
  is((v): v is string => typeof v === 'string' && v !== '', 'a module id'),
  'expected a module id',
)

const uuid = is((v): v is string => typeof v === 'string' && UUID.test(v), 'a uuid')

async function rosterModule(id: string) {
  const { isRosterModule } = await import('../core/site/players')
  if (!isRosterModule(id)) throw new Error(`${id} keeps no roster`)
  return id
}

/**
 * What the vendor says a name is — a preview, written nowhere.
 *
 * A GET that is still admin-only, checked inside the handler (after the
 * validator, as it always was): fn.ts has no admin-gated GET builder yet.
 */
export const lookupPlayerFn = createServerFn()
  .validator(asValidator(withMessage(obj({ name: str, id: moduleField }), 'expected { id, name }')))
  .handler(async ({ data }) => {
    const { assertAdmin } = await import('../core/authz')
    await assertAdmin()
    const { lookupPlayer } = await import('../core/site/players')
    return lookupPlayer(await rosterModule(data.id), data.name)
  })

export const addPlayerFn = adminFn
  .validator(
    asValidator(
      withMessage(obj({ name: str, id: moduleField, op: flagField }), 'expected { id, name, op? }'),
    ),
  )
  .handler(async ({ data, context }) => {
    const { addPlayer } = await import('../core/site/players')
    return addPlayer(await context.ctx(), await rosterModule(data.id), data.name, data.op)
  })

export const removePlayerFn = adminFn
  .validator(asValidator(withMessage(obj({ uuid, id: moduleField }), 'expected { id, uuid }')))
  .handler(async ({ data, context }) => {
    const { removePlayer } = await import('../core/site/players')
    return removePlayer(await context.ctx(), await rosterModule(data.id), data.uuid)
  })

export const setPlayerOpFn = adminFn
  .validator(
    asValidator(withMessage(obj({ uuid, op: bool, id: moduleField }), 'expected { id, uuid, op }')),
  )
  .handler(async ({ data, context }) => {
    const { setPlayerOp } = await import('../core/site/players')
    return setPlayerOp(await context.ctx(), await rosterModule(data.id), data.uuid, data.op)
  })
