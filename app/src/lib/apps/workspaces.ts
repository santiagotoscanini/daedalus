import { actorLabel } from '../../core/auth'
import { makeCtx } from '../../core/ctx'
import { listExternalApps } from '../../core/settings/external-apps'
import type { RootAnswer } from '../../host/root'
import { requestWorkspaceClone } from '../../host/workspaces'
import { listApps } from '../repo/apps'
import { appRepo } from '../site'

// Ask the host to clone a project's repo into the workspace root — or, when
// the workspace already exists, to pull it. What crosses to the root helper is
// a repo slug; the clone happens host-side over the operator's SSH identity, which
// never enters this container (host/workspaces.ts).
//
// The allowlist is exactly the repos the Apps UI offers a button for: the
// registry apps (keyed <owner>/<name>) and the off-box projects' hand-declared
// slugs. The helper and the host re-validate the slug's shape; this check is what
// keeps the verb from being a general "clone anything as the operator" door, and it
// has to be here rather than in a validator because it is built from the
// registry.

export async function cloneOfferedWorkspace(data: { repo: string }): Promise<RootAnswer> {
  const ctx = await makeCtx()
  const [apps, EXTERNAL_APPS] = await Promise.all([listApps(), listExternalApps(ctx)])
  const offered = new Set([
    ...apps.map((a) => appRepo(ctx.site, a.name).toLowerCase()),
    ...EXTERNAL_APPS.flatMap((e) => (e.repo === null ? [] : [e.repo.toLowerCase()])),
  ])
  if (!offered.has(data.repo.toLowerCase())) {
    return { outcome: 'refused', detail: `${data.repo} is not one of this box's project repos` }
  }
  return requestWorkspaceClone({ repo: data.repo, actor: actorLabel() })
}
