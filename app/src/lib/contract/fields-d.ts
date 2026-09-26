import { type Decoder, is, obj, optional, str, withMessage } from './decode'

// Field decoders for server/{claude,updates}.ts, kept apart from fields.ts
// while several conversions land at once; the coordinator folds them in.
// Each refuses with the sentence the hand-written check it replaced used.

const NODE_ID = /^[0-9a-f]{16}$/

/** A node's id: sixteen lowercase hex digits — what `NODE_ID.test` checked. */
export const nodeIdField: Decoder<string> = withMessage(
  is((v): v is string => typeof v === 'string' && NODE_ID.test(v), 'a node id'),
  'expected a node id',
)

/**
 * A container name, as a request may carry one: a non-empty string.
 *
 * Deliberately a shape check rather than an allowlist: what the containers on
 * this box are called is the nix-rendered pin registry's answer, and the host
 * checks every target against it (stacks/daedalus/host/image-update.sh). What
 * belongs here is that a name is a string at all — everything downstream,
 * including a `jq` expression in a shell script, has been assuming it.
 *
 * `what` names the field in the refusal: "<what> must be a container name".
 */
export const containerNameField = (what: string): Decoder<string> =>
  withMessage(
    is((v): v is string => typeof v === 'string' && v !== '', 'a container name'),
    `${what} must be a container name`,
  )

const imageTargetShape = withMessage(
  obj({
    container: containerNameField('each target'),
    toTag: withMessage(
      optional<string | undefined>(str, undefined),
      'toTag must be a string when present',
    ),
  }),
  'each target must name a container',
)

/**
 * One pin to move: a container, and the tag to move it to when named. An
 * absent `toTag` is absent from the result too, not a key holding undefined.
 */
export const imageTargetField: Decoder<{ container: string; toTag?: string }> = (v, p) => {
  const { container, toTag } = imageTargetShape(v, p)
  return toTag === undefined ? { container } : { container, toTag }
}
