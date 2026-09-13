import { actorLabel } from '../../core/auth'
import { makeCtx } from '../../core/ctx'
import { listExternalApps } from '../../core/settings/external-apps'
import { requestWorkspaceClone } from '../../host/workspaces'
import { listApps } from '../repo/apps'
import { OWNER } from '../site'

// Ask the host to clone a project's repo into the workspace root — or, when
// the workspace already exists, to pull it. What crosses the bridge is a repo
// slug; the clone happens host-side over the operator's SSH identity, which
// never enters this container (host/workspaces.ts).
//
// The allowlist is exactly the repos the Apps UI offers a button for: the
// registry apps (keyed OWNER/<name>) and the off-box projects' hand-declared
// slugs. The host re-validates the slug's shape; this check is what keeps the
// bridge from being a general "clone anything as the operator" door, and it
// has to be here rather than in a validator because it is built from the
// registry.

export async function cloneOfferedWorkspace(data: { repo: string }) {
  const [apps, EXTERNAL_APPS] = await Promise.all([listApps(), makeCtx().then(listExternalApps)])
  const offered = new Set([
    ...apps.map((a) => `${OWNER}/${a.name}`.toLowerCase()),
    ...EXTERNAL_APPS.flatMap((e) => (e.repo === null ? [] : [e.repo.toLowerCase()])),
  ])
  if (!offered.has(data.repo.toLowerCase())) {
    throw new Error(`${data.repo} is not one of this box's project repos`)
  }

  const actor = actorLabel()
  return { id: await requestWorkspaceClone({ repo: data.repo, actor }) }
}
