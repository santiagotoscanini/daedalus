import { type ApplyStatus, readApplyStatus } from './apply'
import { currentChanges } from './apply-flow'

// Everything the next Apply would do, in the Apply bar's vocabulary — for the
// bar in the root layout, which every page without its own shows.
//
// An Apply writes every file and rebuilds once, so the bar has to say all of
// it wherever it is drawn: the apps that drifted from nix, the site document
// (settings, a service's cog, a game server's roster), and the machines. It
// is the Apply's own `currentChanges()`, so the bar cannot promise what the
// button would not do.

export type PendingApply = {
  changed: { name: string; fields: string[] }[]
  status: ApplyStatus
}

export async function pendingApply(): Promise<PendingApply> {
  const [{ changed }, status] = await Promise.all([currentChanges(), readApplyStatus()])
  return { changed, status }
}
