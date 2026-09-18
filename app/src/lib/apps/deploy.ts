import { actorLabel } from '../../core/auth'
import { requestDeploy } from '../../host/deploy'
import { getApp } from '../repo/apps'

// Ask the host to run an app's deploy unit now, instead of waiting up to two
// minutes for its timer. Same unit either way — this only removes latency.
//
// `actor` is optional and defaults to the ambient forward-auth label, which is
// what the button wants. A caller that is NOT running inside a request — the
// MCP tool, which is authenticated by a token rather than a session — passes
// its own, so the deploy record names the door it came through instead of
// falling back to "unknown operator".
export async function requestManualDeploy(name: string, actor?: string) {
  const record = await getApp(name)
  if (!record) throw new Error(`no app named ${name}`)
  if (record.sourceMode === 'local') {
    throw new Error(`${name} builds from source in the flake repo — there is no image to pull`)
  }

  return {
    id: await requestDeploy({ app: name, reason: 'manual redeploy', actor: actor ?? actorLabel() }),
  }
}
