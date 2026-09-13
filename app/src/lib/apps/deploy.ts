import { actorLabel } from '../../core/auth'
import { requestDeploy } from '../../host/deploy'
import { getApp } from '../repo/apps'

// Ask the host to run an app's deploy unit now, instead of waiting up to two
// minutes for its timer. Same unit either way — this only removes latency.

export async function requestManualDeploy(name: string) {
  const record = await getApp(name)
  if (!record) throw new Error(`no app named ${name}`)
  if (record.sourceMode === 'local') {
    throw new Error(`${name} builds from source in the flake repo — there is no image to pull`)
  }

  const actor = actorLabel()
  return { id: await requestDeploy({ app: name, reason: 'manual redeploy', actor }) }
}
