// Step 3 of "add an app": what the box will find when it goes to build and run
// this repo — and, deliberately, nothing that stops it being created.
//
// The image check is not a gate. An entry whose image does not exist would
// declare a container that cannot pull, failing the switch and reverting the
// Apply — but the answer to that is the `declared` stage
// (nix/modules/apps/apps.nix), not a disabled button. A new app is created
// declared, so a missing image is the expected state, and the reason the entry
// has to exist first: being in site/apps.json is what earns an app its first
// build. Nothing in this file blocks, and nothing should.
//
// Pure on purpose — no React, no server imports. The component that renders
// this should have nothing left to decide.

/**
 * A single preflight answer.
 *
 * `unknown` is a first-class state and NOT a synonym for `bad`: an image
 * override pointing at a registry this box cannot see is unverified, not
 * broken, and reporting that as a failure would misread a legitimate fork.
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

/**
 * What the repository says about how it wants to be built, as the GitHub App
 * can see it. `unknown` is GitHub declining to answer, not an empty repo.
 */
export type RepoBuild = 'railpack' | 'dockerfile' | 'none' | 'unknown'

export type Readiness = {
  /** Every row is settled — nothing here is worth stopping over. */
  ready: boolean
  verdict: { state: CheckState; headline: string; subject: string }
  /** Rows worth reading before creating. Nothing here prevents creating. */
  act: Check[]
  /** Passing or unknowable — nothing to do about any of them. */
  settled: Check[]
}

function imageCheck(state: ImageState, effectiveImage: string): Check {
  if (state === 'present') {
    return {
      id: 'image',
      label: 'Image',
      state: 'ok',
      detail: `${effectiveImage} is already in the registry`,
      fix: 'Already built, so this app can be promoted to internal or external as soon as the entry is applied.',
    }
  }
  if (state === 'unverifiable') {
    return {
      id: 'image',
      label: 'Image',
      state: 'unknown',
      detail: `${effectiveImage} is not on this box's registry — cannot be checked from here`,
    }
  }
  return {
    id: 'image',
    label: 'Image',
    state: 'ok',
    detail: `${effectiveImage} does not exist yet — which is expected`,
    fix:
      'The entry comes first: the box only builds apps already in site/apps.json. Create it, ' +
      'Apply, then build the repo from its app page — and promote it off `declared` once that ' +
      'build has published an image.',
  }
}

const BUILD_ID = 'build-config'
const BUILD_LABEL = 'Build configuration'

function buildCheck(repoBuild: RepoBuild): Check {
  switch (repoBuild) {
    case 'railpack':
      return {
        id: BUILD_ID,
        label: BUILD_LABEL,
        state: 'ok',
        detail: 'The repo has a railpack.json, so Railpack will build it',
      }
    case 'dockerfile':
      return {
        id: BUILD_ID,
        label: BUILD_LABEL,
        state: 'ok',
        detail: 'No railpack.json, but the repo has a Dockerfile',
        fix: 'The build will use the Dockerfile strategy — the repo describes its own image.',
      }
    case 'none':
      return {
        id: BUILD_ID,
        label: BUILD_LABEL,
        state: 'warn',
        detail: 'The repo has neither a railpack.json nor a Dockerfile',
        fix:
          'Railpack can work zero-config, but none of this box’s seven apps did: each one needed ' +
          'a start command and exact toolchain pins in a railpack.json before its image ran. ' +
          'Creating the entry is fine — the first build is where you would find out.',
      }
    case 'unknown':
      return {
        id: BUILD_ID,
        label: BUILD_LABEL,
        state: 'unknown',
        detail: 'GitHub did not say whether the repo has a railpack.json or a Dockerfile',
      }
  }
}

/** warn outranks unknown outranks ok; `bad` still wins, though nothing emits one. */
const RANK: Record<CheckState, number> = { ok: 0, unknown: 1, warn: 2, bad: 3 }

export function readiness(input: {
  imageState: ImageState
  effectiveImage: string
  repoBuild: RepoBuild
}): Readiness {
  const image = imageCheck(input.imageState, input.effectiveImage)
  const checks = [image, buildCheck(input.repoBuild)]
  // `unknown` is not something to act on — it is the honest answer to a
  // question this box cannot answer — so only warn and bad reach the act list.
  const act = checks.filter((c) => c.state === 'warn' || c.state === 'bad')
  const worst = checks.reduce((a, b) => (RANK[b.state] > RANK[a.state] ? b : a), image)

  return {
    ready: act.length === 0,
    verdict: {
      state: worst.state,
      headline: headline(input.imageState),
      subject: input.effectiveImage,
    },
    act,
    settled: checks.filter((c) => !act.includes(c)),
  }
}

function headline(imageState: ImageState): string {
  if (imageState === 'unverifiable') {
    return 'That image lives on a registry this box cannot see, so nothing here can confirm it'
  }
  if (imageState === 'present') {
    return 'The image is published, so this app can be promoted as soon as it is applied'
  }
  return 'Nothing is blocking: a new app is created declared, and its first build comes after the Apply'
}
