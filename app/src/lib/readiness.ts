// Step 3 of "add an app", as a plan rather than as a list.
//
// The checks repoChecks returns are not peers. They form a graph with exactly
// one outcome — is there an image in the registry this box can pull? — and a
// repo with no workflows fails five of the rows at once: the image is missing,
// the workflow that would have built it is missing, and three more rows say
// "no workflow contents could be read", which is the same finding wearing
// three hats. Reported flat, that is one cause printed five times and a reader
// left to do the causal reasoning themselves.
//
// So the graph is encoded here, as data, and this module answers the one
// question the step exists for: what is actually wrong, what is merely waiting
// on it, and what needs no attention at all.
//
// Pure on purpose — no React, no server imports. The causal reasoning is the
// part worth testing, and the component that renders it should have nothing
// left to decide.

import type { Check, CheckState } from './github-repos'

export type ImageState = 'present' | 'missing' | 'unverifiable'

/** A check that cannot be judged yet, and the short name of what it waits on. */
export type BlockedCheck = Check & { waitingOn: string }

export type Readiness = {
  /** Nothing left to do: the image exists and no check is failing. */
  ready: boolean
  verdict: { state: CheckState; headline: string; subject: string }
  /** Actionable root causes, in dependency order. Only `bad` lands here. */
  act: Check[]
  /** Undeterminable until an upstream is fixed. */
  blocked: BlockedCheck[]
  /** Passing, warning, or unknowable — nothing to do about any of them. */
  settled: Check[]
  /**
   * One phrase for the blocked disclosure. The whole set usually waits on the
   * same thing; when it does not, saying so beats naming one of several.
   */
  waitingOn: string
}

type Node = {
  /** What must be true before this check can mean anything. */
  needs: readonly string[]
  /** How this check is named by the rows waiting on it. */
  waited: string
}

/**
 * The graph, as data.
 *
 * `runner-compatible` and `workflow-secrets` hang off the workflows without
 * feeding the image: a job that cannot run on our runners, or one missing a
 * secret it reads, is a real failure of that workflow and not of the image
 * push — the release workflow can still land an image while the test job is
 * red.
 */
const GRAPH: Record<string, Node> = {
  workflows: { needs: [], waited: 'the workflows' },
  'image-workflow': { needs: ['workflows'], waited: 'the publishing workflow' },
  'runner-compatible': { needs: ['workflows'], waited: 'the workflows' },
  'workflow-secrets': { needs: ['workflows'], waited: 'the workflows' },
  containerfile: { needs: [], waited: 'a Dockerfile' },
  'registry-secret': { needs: [], waited: 'the registry secret' },
  'runner-pat': { needs: [], waited: 'the runner credential' },
  image: {
    needs: ['image-workflow', 'containerfile', 'registry-secret', 'runner-pat'],
    waited: 'the image',
  },
}

/** Topological: every id appears after everything it needs. */
const ORDER = [
  'workflows',
  'image-workflow',
  'runner-compatible',
  'workflow-secrets',
  'containerfile',
  'registry-secret',
  'runner-pat',
  'image',
]

/**
 * The headline for each root cause, phrased as the outcome rather than as the
 * check's name — "nothing publishes an image" is what the reader has to act
 * on; "CI workflows ✗" is the row that noticed.
 */
const HEADLINE_MISSING: Record<string, string> = {
  workflows: 'Nothing in this repo publishes an image yet',
  'image-workflow': 'None of this repo’s workflows pushes an image to the box’s registry',
  'runner-compatible': 'The workflows cannot run on this box’s runners',
  'workflow-secrets': 'The workflows are missing secrets they read',
  'registry-secret': 'The repo cannot sign in to the registry, so the image push would be rejected',
  image: 'The image hasn’t been built yet',
}

/** The same causes, when an image already exists and it is the NEXT one at risk. */
const HEADLINE_PUBLISHED: Record<string, string> = {
  workflows: 'The image is published, but nothing in the repo would rebuild it',
  'image-workflow': 'The image is published, but no workflow here would rebuild it',
  'runner-compatible': 'The image is published, but the workflows cannot run on this box’s runners',
  'workflow-secrets': 'The image is published, but the workflows are missing secrets they read',
  'registry-secret': 'The image is published, but the repo can no longer sign in to the registry',
}

/** The one check the platform owns rather than reads. Always the same answer. */
const RUNNER_PAT: Check = {
  id: 'runner-pat',
  label: 'CI runner credential',
  state: 'ok',
  detail:
    'The PAT in stacks/gha-runner/env.sops covers every repository on the account, so declaring the app is all its runner needs.',
  fix: 'If the runner unit ever fails ExecStartPre with a 404, that PAT’s repository access is the thing to check — daedalus cannot see it from here.',
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
        ? 'Run the image workflow once. Until the image exists, the container would restart-loop from the moment this entry is applied — which is why this is the one check that blocks.'
        : undefined,
  }
}

/**
 * The nearest ancestor that is actually broken.
 *
 * Walks up through `unknown` links — a row that could not be read because the
 * row above it could not be read is still waiting on whatever broke first, and
 * naming the intermediate would hand the reader a second hop to make. An `ok`
 * or `warn` ancestor ends the walk: that branch is fine.
 */
function rootCause(id: string, byId: Map<string, Check>, seen: Set<string>): Check | null {
  if (seen.has(id)) return null
  seen.add(id)
  for (const up of GRAPH[id]?.needs ?? []) {
    const c = byId.get(up)
    if (c === undefined) continue
    if (c.state === 'bad') return c
    if (c.state === 'unknown') {
      const deeper = rootCause(up, byId, seen)
      if (deeper !== null) return deeper
    }
  }
  return null
}

export function readiness(input: {
  checks: readonly Check[]
  imageState: ImageState
  effectiveImage: string
}): Readiness {
  const all = [
    ...input.checks,
    imageCheck(input.imageState, input.effectiveImage),
    // Appended rather than expected in `checks`: nothing reads it from GitHub,
    // it is a statement about a secret this box holds.
    RUNNER_PAT,
  ]
  const byId = new Map(all.map((c) => [c.id, c]))

  // ORDER first, then anything the graph has not heard of yet — a check added
  // to repoChecks must still appear, unordered rather than dropped.
  const ids = [
    ...ORDER.filter((id) => byId.has(id)),
    ...all.map((c) => c.id).filter((id) => !ORDER.includes(id)),
  ]

  const act: Check[] = []
  const blocked: BlockedCheck[] = []
  const settled: Check[] = []

  for (const id of ids) {
    const c = byId.get(id)
    if (c === undefined) continue
    // A warn is not a blocker and never an action: "no Dockerfile at the root"
    // is fine when the workflow builds from elsewhere, and a page that demands
    // it would be demanding something that is not required.
    if (c.state === 'ok' || c.state === 'warn') {
      settled.push(c)
      continue
    }
    const root = rootCause(id, byId, new Set())
    if (root !== null) {
      blocked.push({ ...c, waitingOn: GRAPH[root.id]?.waited ?? root.label })
      continue
    }
    if (c.state === 'bad') act.push(c)
    else settled.push(c)
  }

  const root = act[0] ?? null
  const waits = [...new Set(blocked.map((b) => b.waitingOn))]

  return {
    ready: input.imageState === 'present' && act.length === 0,
    verdict: {
      state: verdictState(input.imageState, act.length),
      headline: headline(input.imageState, root),
      subject: input.effectiveImage,
    },
    act,
    blocked,
    settled,
    waitingOn: waits.length === 1 ? (waits[0] ?? '') : 'something above',
  }
}

function verdictState(imageState: ImageState, actCount: number): CheckState {
  // Unverifiable is not a failure and does not block: an override pointing at
  // GHCR is a legitimate app, and the honest answer is that this box cannot
  // see that registry — which is what `unknown` means everywhere else here.
  if (imageState === 'unverifiable') return 'unknown'
  if (imageState === 'missing') return 'bad'
  return actCount === 0 ? 'ok' : 'warn'
}

function headline(imageState: ImageState, root: Check | null): string {
  if (imageState === 'unverifiable') {
    return 'That image lives on a registry this box cannot see, so nothing here can confirm it'
  }
  if (imageState === 'present') {
    if (root === null) return 'Everything this repo needs is in place'
    return HEADLINE_PUBLISHED[root.id] ?? `The image is published, but ${root.label} needs fixing`
  }
  return (
    HEADLINE_MISSING[root?.id ?? 'image'] ??
    `Nothing can build the image until ${root?.label ?? 'this'} is fixed`
  )
}
