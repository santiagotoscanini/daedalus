import { defineBridge } from './bridge'

// The app half of an image update. It writes one file and reads another.
//
// Everything privileged happens on the host: a systemd.path unit watches
// image-request.json and starts daedalus-image-update.service, which resolves
// the new digest, rewrites the pin in the flake, commits, and runs
// nixos-rebuild (stacks/daedalus/host/image-update.sh). This container cannot
// rebuild anything and holds no credential that would let it — lib/bridge.ts
// has the mechanics and the trust boundary.
//
// No payload file, unlike Apply. Apply ships bytes because the app renders the
// whole registry and the host copies it verbatim; here the app has nothing to
// render — the host reads the pin out of the nix-generated registry, which is
// also the allowlist. What crosses is a container name and a tag.

export type ImageUpdateState = 'idle' | 'running' | 'done' | 'failed'

/** One container this run moves — including lockstep members nobody picked. */
export type ImageMove = {
  container: string
  repo: string
  fromTag: string
  fromDigest: string
  toTag: string
  toDigest: string
  /** False when this member was already on the target — reported, not hidden. */
  changed: boolean
}

export type ImageUpdateStatus = {
  id: string | null
  /** The container the request named. The lockstep members are in `moves`. */
  container: string
  state: ImageUpdateState
  phase: string
  error: string
  /** Empty until the host has resolved what it intends to do. */
  moves: ImageMove[]
  startedAt: string | null
  finishedAt: string | null
  commit: string | null
}

export const IDLE_UPDATE: ImageUpdateStatus = {
  id: null,
  container: '',
  state: 'idle',
  phase: '',
  error: '',
  moves: [],
  startedAt: null,
  finishedAt: null,
  commit: null,
}

const bridge = defineBridge<ImageUpdateStatus>({
  requestFile: 'image-request.json',
  statusFile: 'image-status.json',
  idle: IDLE_UPDATE,
})

export async function readImageUpdateStatus(): Promise<ImageUpdateStatus> {
  return bridge.readStatus()
}

/**
 * Publish an update request.
 *
 * `toTag` absent means "re-resolve the tag this container is already on",
 * which is the entire update for a channel pin like `:latest` — the tag has
 * moved and the pin has not. For a release pin it is the tag the operator
 * chose off the candidate list after reading what changed.
 */
export async function requestImageUpdate(input: {
  container: string
  toTag?: string
  actor: string
}): Promise<string> {
  return bridge.request({
    container: input.container,
    ...(input.toTag === undefined ? {} : { toTag: input.toTag }),
    actor: input.actor,
  })
}
