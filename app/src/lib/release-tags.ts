// Tag patterns for `versionGap`, for the projects whose tags are not `vX.Y.Z`.
//
// Pure, and kept out of image-repos on purpose. image-repos globs every
// module's `releases.ts` eagerly, so a `releases.ts` that imported a value
// back from it would evaluate before that value exists; and image-repos
// reads the machine, which a `releases.ts` — client code by contract, see
// host/boundary.test.ts — may not reach.

/** The *arr build number is the fourth segment, and it is the one that moves. */
export const ARR_TAG = /^v?(\d+\.\d+\.\d+\.\d+)$/
/** Two segments or three — for projects that ship both `4.3` and `4.3.1`. */
export const TWO_OR_THREE = /^v?(\d+\.\d+(?:\.\d+)?)$/
