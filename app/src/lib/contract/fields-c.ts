import { type Decoder, is, withMessage } from './decode'

// More shared field decoders for server-function inputs (see fields.ts),
// kept apart only so parallel edits did not collide; merge into fields.ts.

const NODE_ID = /^[0-9a-f]{16}$/

const isNodeId = (v: unknown): v is string => typeof v === 'string' && NODE_ID.test(v)

/** A node's id as the agent mints it: 16 lowercase hex digits. */
export const nodeIdField: Decoder<string> = withMessage(
  is(isNodeId, 'a node id'),
  'expected a node id',
)

/** An opt-in switch: exactly `true` is on, anything else — absent included — is off. */
export const flagField: Decoder<boolean> = (v) => v === true

/** A string with something in it besides whitespace, handed back untrimmed. */
export function nonBlankField(message: string): Decoder<string> {
  return (v) => {
    if (typeof v !== 'string' || v.trim() === '') throw new Error(message)
    return v
  }
}
