// Step 3 of "add an app": is there an image in the registry this box can pull?
//
// It used to be a graph. Seven repo-side checks came back from GitHub — the
// workflows, the publishing one, the repo secret, the runner credential — and
// this module untangled which of them were causes and which were consequences,
// because a repo with no workflows failed five rows at once and reported one
// cause five times. Builds run on the box now (the GitHub App, the build
// queue, Railpack), so none of those repo-side facts is daedalus's to read any
// more, and the step is back to the one question it always existed to answer.
//
// Pure on purpose — no React, no server imports. The component that renders
// this should have nothing left to decide.

/**
 * A single preflight answer.
 *
 * `unknown` is a first-class state and NOT a synonym for `bad`: an image
 * override pointing at a registry this box cannot see is unverified, not
 * broken, and reporting that as a failure would block a legitimate fork.
 */
export type CheckState = 'ok' | 'warn' | 'bad' | 'unknown'

export type Check = {
  id: string
  label: string
  state: CheckState
  detail: string
  /** What to do about it, when there is something to do. */
  fix?: string
}

export type ImageState = 'present' | 'missing' | 'unverifiable'

export type Readiness = {
  /** Nothing left to do: the image exists. */
  ready: boolean
  verdict: { state: CheckState; headline: string; subject: string }
  /** Actionable root causes. Only `bad` lands here. */
  act: Check[]
  /** Passing, warning, or unknowable — nothing to do about any of them. */
  settled: Check[]
}

function imageCheck(state: ImageState, effectiveImage: string): Check {
  return {
    id: 'image',
    label: 'Image published',
    state: state === 'present' ? 'ok' : state === 'missing' ? 'bad' : 'unknown',
    detail:
      state === 'present'
        ? `${effectiveImage} is in the registry`
        : state === 'missing'
          ? `${effectiveImage} does not exist yet`
          : `${effectiveImage} is not on this box's registry — cannot be checked from here`,
    fix:
      state === 'missing'
        ? 'Push to the default branch, or build the repo from its app page once the entry exists. Until the image exists, the container would restart-loop from the moment this entry is applied — which is why this is the one check that blocks.'
        : undefined,
  }
}

export function readiness(input: { imageState: ImageState; effectiveImage: string }): Readiness {
  const check = imageCheck(input.imageState, input.effectiveImage)
  const bad = check.state === 'bad'
  return {
    ready: input.imageState === 'present',
    verdict: {
      // Unverifiable is not a failure and does not block: an override pointing
      // at GHCR is a legitimate app, and the honest answer is that this box
      // cannot see that registry.
      state: check.state,
      headline: headline(input.imageState),
      subject: input.effectiveImage,
    },
    act: bad ? [check] : [],
    settled: bad ? [] : [check],
  }
}

function headline(imageState: ImageState): string {
  if (imageState === 'unverifiable') {
    return 'That image lives on a registry this box cannot see, so nothing here can confirm it'
  }
  if (imageState === 'present') return 'The image is published and this box can pull it'
  return 'The image hasn’t been built yet'
}
