import { arrayOf, asValidator, obj, withMessage } from '../lib/contract/decode'
import { containerNameField, imageTargetField } from '../lib/contract/fields'
import { adminFn, readFn } from './fn'

// Server functions behind the Updates page and the Update button.
//
// Its own module rather than a corner of server/category.ts: the category
// loaders answer "what is this service doing", one page at a time, and these
// three answer "move this pin" — a write, its status, and the notes a person
// reads before deciding. The Update button also lives on service tabs across
// five categories, so hanging these off any one category's loader would be
// backwards.
//
// Value imports are dynamic, like every other server module here: the bridge
// reaches for node:fs and nothing below may be pulled into a client bundle.
// What a container name is lives in lib/contract/fields.ts.

/**
 * The notes for one container, on demand.
 *
 * Separate from the table's own loader on purpose — see the note in
 * modules/system/data/updates.ts about not spending the GitHub
 * budget on sixty-four containers nobody expanded.
 */
export const fetchUpdateNotes = readFn
  .validator(
    asValidator(
      withMessage(obj({ container: containerNameField('container') }), 'expected a container'),
    ),
  )
  .handler(async ({ data }) => {
    const { loadUpdateNotes } = await import('../modules/system/data/updates')
    return loadUpdateNotes(data.container)
  })

export const fetchImageUpdateStatus = readFn.handler(async () => {
  const { readImageUpdateStatus } = await import('../host/image-update')
  return readImageUpdateStatus()
})

/**
 * Ask the host to move one or more pins and rebuild onto them.
 *
 * Returns as soon as the request is published, which is before the host has
 * validated anything: a container may not be pinned, may be declared not
 * updatable, or the registry may refuse its tag. All three are reported
 * through the status file, which the caller polls — the same contract Apply
 * has, and the reason the button shows a phase rather than a spinner.
 *
 * Always a list, even for one: the button and the queue are the same call, so
 * there is no single-container path that could behave differently from the
 * batch one.
 *
 * The validator says what the MCP `image.update` tool's schema says: both are
 * doors onto the same runImageUpdate, and a request one refuses is not one
 * the other should publish to the host.
 */
export const requestImageUpdateFn = adminFn
  .validator(
    asValidator(
      withMessage(obj({ targets: arrayOf(imageTargetField) }), 'expected a list of targets'),
    ),
  )
  .handler(async ({ data, context }) => {
    const { runImageUpdate } = await import('../host/update-flow')
    // The forward-auth middleware forwards the Pocket ID claim, so the commit
    // this produces records a person rather than "daedalus".
    return runImageUpdate({ targets: data.targets, actor: context.actor() })
  })

// ── the engine ────────────────────────────────────────────────────────────
//
// The same pair for the engine's own pin: its status, and the one request.
// Beside the image functions rather than in a module of their own because
// the Updates page is the only page either is on, and the button is the same
// gesture one card up.

export const fetchEngineUpdateStatus = readFn.handler(async () => {
  const { readEngineUpdateStatus } = await import('../host/engine-update')
  return readEngineUpdateStatus()
})

/**
 * Ask the host to move the engine's pin to the clone's `main` and rebuild.
 *
 * Nothing to validate: the request carries only the actor. What "latest" is,
 * and whether the box is in a state to take it (no engine override, the
 * clone not diverged), is the host's answer — reported through the status
 * file the caller polls, like every other bridge verb.
 */
export const requestEngineUpdateFn = adminFn.handler(async ({ context }) => {
  const { runEngineUpdate } = await import('../host/engine-flow')
  return runEngineUpdate({ actor: context.actor() })
})

/**
 * Where the NixOS release stands — the live half of the NixOS card.
 *
 * On demand rather than in the tab's loader, for the loader's own reason
 * (modules/system/data/updates.ts, "it costs no network"): this asks
 * endoflife.date and GitHub, cached hourly in core/settings/nixos, and the
 * card's facts render from the export before the answer lands.
 */
export const fetchNixosRelease = readFn.handler(async () => {
  const { nixosRelease } = await import('../core/settings/nixos')
  const { siteIdentity } = await import('../host/contract/domains/site')
  const site = await siteIdentity()
  return nixosRelease(site.data.nixos)
})
