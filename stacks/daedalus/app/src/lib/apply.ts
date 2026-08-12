import { defineBridge } from './bridge'

// The app half of Apply. It writes one file and reads another.
//
// Everything privileged happens on the host: a systemd.path unit watches
// request.json and starts daedalus-apply.service, which commits the export
// and runs nixos-rebuild (stacks/daedalus/host/apply.sh). This container
// cannot rebuild anything and holds no credential that would let it — see
// lib/bridge.ts for the mechanics and the trust boundary.

export type ApplyState = 'idle' | 'running' | 'done' | 'failed'

export type ApplyStatus = {
  id: string | null
  state: ApplyState
  phase: string
  error: string
  finishedAt: string | null
  commit: string | null
}

const bridge = defineBridge<ApplyStatus>({
  requestFile: 'request.json',
  statusFile: 'status.json',
  idle: { id: null, state: 'idle', phase: '', error: '', finishedAt: null, commit: null },
})

export async function readApplyStatus(): Promise<ApplyStatus> {
  return bridge.readStatus()
}

/**
 * Publish an apply request: the exact bytes to land in the flake, rendered
 * here (see lib/registry-file.ts) so the host agent never manipulates JSON —
 * it copies apps.json verbatim. request.json carries metadata only.
 */
export async function requestApply(input: {
  fileBody: string
  summary: string
  actor: string
}): Promise<string> {
  return bridge.request(
    { actor: input.actor, summary: input.summary },
    { file: 'apps.json', body: input.fileBody },
  )
}

/** Human-readable one-liner for the commit message. */
export function summarise(changed: { name: string; fields: string[] }[]): string {
  if (changed.length === 0) return 'no-op re-export'
  if (changed.length === 1) {
    const only = changed[0]
    if (!only) return 'update app registry'
    return `${only.name}: ${only.fields.join(', ')}`
  }
  return `${String(changed.length)} apps updated (${changed.map((c) => c.name).join(', ')})`
}
