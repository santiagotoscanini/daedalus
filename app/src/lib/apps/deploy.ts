import type { Ctx } from '../../core/ctx'
import { requestDeploy } from '../../host/deploy'
import type { RootAnswer } from '../../host/root'
import { getApp } from '../repo/apps'

// Ask the host to run an app's deploy unit now, instead of waiting up to two
// minutes for its timer. Same unit either way — this only removes latency.
// Answers when the unit has finished (host/deploy.ts).
//
// `actor` is the door's: the button's forward-auth label, or the MCP tool's
// own, so the journal names the door it came through.
export async function requestManualDeploy(
  ctx: Pick<Ctx, 'controller'>,
  name: string,
  actor: string,
): Promise<RootAnswer> {
  const record = await getApp(name)
  if (!record) throw new Error(`no app named ${name}`)
  if (record.sourceMode === 'local') {
    throw new Error(`${name} builds from source in the flake repo — there is no image to pull`)
  }
  return requestDeploy(ctx, { app: name, reason: 'manual redeploy', actor })
}
