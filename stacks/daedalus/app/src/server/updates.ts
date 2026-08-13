import { createServerFn } from '@tanstack/react-start'
import { getRequestHeader } from '@tanstack/react-start/server'

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

/**
 * The notes for one container, on demand.
 *
 * Separate from the table's own loader on purpose — see the note in
 * lib/dashboard/categories/system/updates.ts about not spending the GitHub
 * budget on sixty-four containers nobody expanded.
 */
export const fetchUpdateNotes = createServerFn()
  .inputValidator((input: { container: string }) => input)
  .handler(async ({ data }) => {
    const { loadUpdateNotes } = await import('../lib/dashboard/categories/system/updates')
    return loadUpdateNotes(data.container)
  })

export const fetchImageUpdateStatus = createServerFn().handler(async () => {
  const { readImageUpdateStatus } = await import('../lib/image-update')
  return readImageUpdateStatus()
})

/**
 * Ask the host to move a pin and rebuild onto it.
 *
 * Returns as soon as the request is published, which is before the host has
 * validated anything: the container may not be pinned, may be declared not
 * updatable, or the registry may refuse the tag. All three are reported
 * through the status file, which the caller polls — the same contract Apply
 * has, and the reason the button shows a phase rather than a spinner.
 */
export const requestImageUpdateFn = createServerFn({ method: 'POST' })
  .inputValidator((input: { container: string; toTag?: string }) => input)
  .handler(async ({ data }) => {
    const { runImageUpdate } = await import('../lib/update-flow')
    // The forward-auth middleware forwards the Pocket ID claim, so the commit
    // this produces records a person rather than "daedalus".
    const actor = getRequestHeader('x-forwarded-email') ?? 'unknown operator'
    return runImageUpdate({ ...data, actor })
  })
