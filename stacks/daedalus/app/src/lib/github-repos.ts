// The repositories an app could be created from, and whether each one is
// actually ready to become one.
//
// Read-only, deliberately. Daedalus creates the registry ENTRY; it does not
// create repos, push workflows or set repo secrets. That half stays manual for
// the same reason the runner PAT never enters a container (lib/ci.ts): a
// credential that can write to a repo is a credential that can change what CI
// builds and therefore what this box runs, and the control plane already has
// enough reach. What daedalus can do is tell you, before you commit to an
// entry, exactly which of the manual steps are still missing — the checks
// below are the checklist from stacks/apps/declarations.nix, answered.
//
// Separate from lib/dashboard/github.ts, which reads four public projects'
// release notes. Same API, different question and different credential: that
// one wants rate-limit headroom on public data, this one needs to SEE private
// repos of the account, which the GHCR pull token cannot.

import { swrCache } from './cache'
import { key } from './keys'
import { OWNER, REGISTRY_HOST_PATTERN } from './site'

// Every app repo lives under OWNER (site.ts, nix-bound) — the same assumption
// stacks/gha-runner makes. Re-exported so this module's many importers keep
// their import path.
export { OWNER }

/**
 * Listings change when a repo is pushed to, which is minutes-to-days apart,
 * and the picker is re-rendered on every keystroke of the search box. A short
 * cache keeps typing from spending the hourly budget.
 */
const TTL_MS = 60_000

const cache = swrCache({ ttlMs: TTL_MS })

/**
 * The credential these reads authenticate with.
 *
 * `GITHUB_REPO_TOKEN` first, when service-keys.sops defines one — that key
 * exists so this can be narrowed to a read-only PAT independently of the
 * credential below.
 *
 * Otherwise `GITHUB_TOKEN`, which is the GHCR pull credential re-shaped by a
 * boot oneshot (stacks/daedalus/daedalus.nix) and already present for the
 * release-notes panels. It is a classic PAT carrying `repo`, so it can list
 * private repositories, read `.github/workflows` inside them and read their
 * Actions secret names — everything the create flow needs. Worth knowing what
 * that means: `repo` is read-WRITE on every repository on the account, and
 * this module only ever issues GETs. Narrowing it is what the first key is
 * for.
 *
 * Neither present is a supported state: the listing falls back to the
 * account's PUBLIC repos and the checks that need authentication report
 * `unknown` rather than failing. The UI says which it is — an empty list
 * because a token is missing must not read as "you have no repos".
 */
function token(): string | null {
  return key('GITHUB_REPO_TOKEN') || key('GITHUB_TOKEN') || null
}

function headers(): Record<string, string> {
  const t = token()
  return {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(t ? { Authorization: `Bearer ${t}` } : {}),
  }
}

export type Repo = {
  name: string
  description: string | null
  private: boolean
  archived: boolean
  language: string | null
  pushedAt: string | null
  htmlUrl: string
}

export type RepoList = {
  repos: Repo[]
  /** False when the token is absent — the list is then public repos only. */
  authenticated: boolean
  /** Set when GitHub refused. The list is empty AND the reason is shown. */
  error: string | null
}

type GhRepo = {
  name?: string
  description?: string | null
  private?: boolean
  archived?: boolean
  language?: string | null
  pushed_at?: string | null
  html_url?: string
}

/**
 * The account's repositories, most recently pushed first.
 *
 * `/user/repos` with a token (it sees private ones), `/users/{owner}/repos`
 * without. One page of 100: this is a personal account, and a picker that
 * paginates is a picker nobody scrolls to the end of. The search box filters
 * what came back rather than querying — 100 names filter instantly and the
 * search API has a far tighter rate limit.
 */
export async function listRepos(): Promise<RepoList> {
  return cache.get('repos', async () => {
    const authenticated = token() !== null
    const url = authenticated
      ? 'https://api.github.com/user/repos?affiliation=owner&sort=pushed&per_page=100'
      : `https://api.github.com/users/${OWNER}/repos?sort=pushed&per_page=100`

    try {
      const res = await fetch(url, { headers: headers(), signal: AbortSignal.timeout(10_000) })
      if (!res.ok) {
        return {
          repos: [],
          authenticated,
          error: `GitHub answered ${String(res.status)} — ${
            res.status === 401
              ? 'the token is rejected; rotate DASH_GITHUB_REPO_TOKEN'
              : res.status === 403
                ? 'rate limited, or the token lacks repository read'
                : 'unexpected'
          }`,
        }
      }

      const body = (await res.json()) as GhRepo[]
      return {
        authenticated,
        error: null,
        repos: body
          .filter((r): r is GhRepo & { name: string } => typeof r.name === 'string')
          .map((r) => ({
            name: r.name,
            description: r.description ?? null,
            private: r.private ?? false,
            archived: r.archived ?? false,
            language: r.language ?? null,
            pushedAt: r.pushed_at ?? null,
            htmlUrl: r.html_url ?? `https://github.com/${OWNER}/${r.name}`,
          })),
      }
    } catch {
      return { repos: [], authenticated, error: 'GitHub could not be reached' }
    }
  })
}

/**
 * A single preflight answer.
 *
 * `unknown` is a first-class state and NOT a synonym for `bad`. Two of these
 * checks can only be answered by a credential daedalus deliberately does not
 * hold; reporting those as failures would train you to click past the
 * checklist, which is the one thing that would make it useless.
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

export type RepoChecks = {
  checks: Check[]
  /** Workflow filenames found, for the detail lines. */
  workflows: string[]
  /**
   * The workflow that pushes an image, by filename — what a Run CI request
   * dispatches. Null when no workflow pushes to the registry (nothing to run)
   * or when it has no `workflow_dispatch` trigger (nothing that CAN be run on
   * demand), which are different problems and reported as such.
   */
  publishWorkflow: string | null
  dispatchable: boolean
}

type GhContent = { name?: string; type?: string; path?: string }

async function ghJson<T>(path: string): Promise<{ status: number; body: T | null }> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: headers(),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) return { status: res.status, body: null }
    return { status: res.status, body: (await res.json()) as T }
  } catch {
    return { status: 0, body: null }
  }
}

async function ghRaw(path: string): Promise<string | null> {
  try {
    const res = await fetch(`https://api.github.com${path}`, {
      headers: { ...headers(), Accept: 'application/vnd.github.raw' },
      signal: AbortSignal.timeout(10_000),
    })
    return res.ok ? await res.text() : null
  } catch {
    return null
  }
}

/** Workflow files read per repo. Enough for ci + image + release, not a crawl. */
const MAX_WORKFLOWS = 6

/**
 * The repo-side half of "add an app", checked rather than remembered.
 *
 * Each of these is a step from the workflow comment in
 * stacks/apps/declarations.nix. Skipping one does not fail the Apply — it
 * fails later and somewhere else (a container that restart-loops on a missing
 * image, a runner unit that restart-loops on a 404 from the registration-token
 * endpoint), which is exactly the kind of failure worth moving forward in
 * time.
 */
export async function repoChecks(repo: string): Promise<RepoChecks> {
  return cache.get(`checks:${repo}`, async () => {
    const checks: Check[] = []

    // --- workflows ---------------------------------------------------------
    const dir = await ghJson<GhContent[]>(
      `/repos/${OWNER}/${repo}/contents/${encodeURIComponent('.github/workflows')}`,
    )
    const files = (dir.body ?? [])
      .filter((f) => f.type === 'file' && (f.name ?? '').match(/\.ya?ml$/))
      .slice(0, MAX_WORKFLOWS)
    const workflows = files.map((f) => f.name ?? '')

    const bodies = await Promise.all(
      files.map((f) =>
        ghRaw(`/repos/${OWNER}/${repo}/contents/${encodeURIComponent(f.path ?? '')}`),
      ),
    )
    const allYaml = bodies.filter((b): b is string => b !== null).join('\n')

    // Which file is the publishing one, and can it be started on demand. Kept
    // per-file rather than over the concatenation: dispatching the workflow
    // that merely *mentions* the registry in a comment would start the wrong
    // run, and `workflow_dispatch` has to be on the file being dispatched.
    const publishIndex = bodies.findIndex(
      (b) => b !== null && new RegExp(`zot:5000|${REGISTRY_HOST_PATTERN}`).test(b),
    )
    const publishWorkflow = publishIndex === -1 ? null : (workflows[publishIndex] ?? null)
    const dispatchable =
      publishIndex !== -1 && (bodies[publishIndex]?.includes('workflow_dispatch') ?? false)

    if (dir.status === 404) {
      checks.push({
        id: 'workflows',
        label: 'CI workflows',
        state: 'bad',
        detail: 'no .github/workflows in the repo',
        fix: 'Copy ci.yml and image.yml from an existing app repo.',
      })
    } else if (dir.body === null) {
      checks.push({
        id: 'workflows',
        label: 'CI workflows',
        state: 'unknown',
        detail:
          dir.status === 0
            ? 'GitHub could not be reached'
            : `GitHub answered ${String(dir.status)}`,
      })
    } else {
      checks.push({
        id: 'workflows',
        label: 'CI workflows',
        state: workflows.length > 0 ? 'ok' : 'bad',
        detail:
          workflows.length > 0
            ? workflows.join(', ')
            : 'the directory exists but holds no workflow files',
      })
    }

    // --- does anything publish an image to this box's registry? ------------
    //
    // Grepping the YAML rather than parsing it: the question is "does this repo
    // push to zot at all", which a substring answers, and a YAML parser here
    // would be a dependency plus a schema to keep in step with GitHub's.
    //
    // `zot:5000` is what the app repos actually write, and it is the string
    // that matters: the runner and zot share the registry-net bridge, so the
    // push resolves the container by name and never leaves the box. The public
    // hostname is matched too, for a workflow that pushes from somewhere with
    // no bridge — but a repo that only mentions `registry.toscanini.me` in a
    // comment is exactly the false positive worth accepting over missing the
    // in-cluster form, which is the one every current app uses.
    checks.push({
      id: 'image-workflow',
      label: 'Publishes an image to the box’s registry',
      state:
        allYaml === ''
          ? 'unknown'
          : publishWorkflow === null
            ? 'bad'
            : dispatchable
              ? 'ok'
              : 'warn',
      detail:
        allYaml === ''
          ? 'no workflow contents could be read'
          : publishWorkflow === null
            ? 'no workflow pushes to zot:5000 — nothing would ever be deployed'
            : dispatchable
              ? `${publishWorkflow} pushes to zot, and can be run on demand`
              : `${publishWorkflow} pushes to zot, but has no workflow_dispatch trigger`,
      fix:
        publishWorkflow === null
          ? 'Add the release workflow that builds and pushes zot:5000/<name>:latest (copy it from an existing app).'
          : dispatchable
            ? undefined
            : 'Add `workflow_dispatch:` to its triggers — without it the first image can only come from a push to the default branch.',
    })

    // --- will these workflows run on OUR runners at all? -------------------
    //
    // The runners have no podman socket, on purpose: santiago's rootless socket
    // is root-equivalent for every stack on this box, and a supply-chain
    // compromised marketplace action must not get it (stacks/gha-runner). The
    // cost is that `services:` and `container:` jobs cannot work — they need a
    // Docker API to bring the container up — and the way that surfaces is a job
    // that dies in ten seconds at "Initialize containers", which reads like an
    // infrastructure fault rather than a policy.
    //
    // Line-anchored and indented, so the word appearing in a comment or in
    // `container: image` prose does not trip it.
    const usesServiceContainers = /^\s{2,}(services|container):/m.test(allYaml)
    checks.push({
      id: 'runner-compatible',
      label: 'Workflows run on this box’s runners',
      state: allYaml === '' ? 'unknown' : usesServiceContainers ? 'bad' : 'ok',
      detail:
        allYaml === ''
          ? 'no workflow contents could be read'
          : usesServiceContainers
            ? 'a job declares services:/container: — our runners have no Docker API, so it fails at "Initialize containers"'
            : 'plain run: steps only',
      fix: usesServiceContainers
        ? 'Replace the service container with something the job starts itself, or run that job on a GitHub-hosted runner. The socket is withheld deliberately — it is root-equivalent on this box.'
        : undefined,
    })

    // --- the container the platform will run -------------------------------
    const root = await ghJson<GhContent[]>(`/repos/${OWNER}/${repo}/contents/`)
    const hasContainerfile = (root.body ?? []).some((f) =>
      ['Dockerfile', 'Containerfile'].includes(f.name ?? ''),
    )
    checks.push({
      id: 'containerfile',
      label: 'Dockerfile at the repo root',
      state: root.body === null ? 'unknown' : hasContainerfile ? 'ok' : 'warn',
      detail:
        root.body === null
          ? 'the repo contents could not be read'
          : hasContainerfile
            ? 'found'
            : 'none at the root — fine if the workflow builds from elsewhere',
    })

    // --- the secrets these workflows read ----------------------------------
    //
    // One listing, two questions. REGISTRY_PASSWORD gets its own row because it
    // is the one value this box owns and can therefore set for you. Everything
    // else the YAML reads gets a second row, informational: a workflow that
    // needs CI_DATABASE_URL and does not have it fails on its own terms, and
    // finding that out from a red run after an app is declared is exactly the
    // ordering this page exists to fix.
    //
    // 403 is the expected answer for a token without `Secrets: read`, and it is
    // reported as unknown rather than bad: the platform never reads these, only
    // CI does, so not being able to see them is a gap in the CHECK.
    const secrets = await ghJson<{ secrets?: { name?: string }[] }>(
      `/repos/${OWNER}/${repo}/actions/secrets?per_page=100`,
    )
    const have = new Set((secrets.body?.secrets ?? []).map((s) => s.name ?? ''))
    const readable = secrets.body !== null

    const hasRegistryPassword = have.has('REGISTRY_PASSWORD')
    checks.push({
      id: 'registry-secret',
      label: 'REGISTRY_PASSWORD repo secret',
      state: !readable ? 'unknown' : hasRegistryPassword ? 'ok' : 'bad',
      detail: !readable
        ? secrets.status === 403
          ? 'the token cannot read repo secrets — check by hand'
          : 'could not be checked'
        : hasRegistryPassword
          ? 'set'
          : 'not set — the image push will 401',
      fix:
        readable && !hasRegistryPassword
          ? 'This box owns that password and can set it for you.'
          : undefined,
    })

    // `${{ secrets.X }}`, minus the one GitHub injects itself. Uppercase-only
    // to match the convention every one of these repos uses; a lowercase secret
    // name would be missed, and a missed row is a check that says less rather
    // than one that says something wrong.
    const referenced = [
      ...new Set([...allYaml.matchAll(/secrets\.([A-Z][A-Z0-9_]*)/g)].map((m) => m[1] ?? '')),
    ].filter((n) => n !== 'GITHUB_TOKEN' && n !== 'REGISTRY_PASSWORD')
    const missing = referenced.filter((n) => !have.has(n))

    if (referenced.length > 0) {
      checks.push({
        id: 'workflow-secrets',
        label: 'Other secrets these workflows read',
        state: !readable ? 'unknown' : missing.length === 0 ? 'ok' : 'bad',
        detail: !readable
          ? `${referenced.join(', ')} — could not be checked`
          : missing.length === 0
            ? `${referenced.join(', ')} — all set`
            : `missing: ${missing.join(', ')}`,
        fix:
          readable && missing.length > 0
            ? 'These belong to the app, not to the platform, so nothing here can supply them: gh secret set <NAME> --repo ' +
              `${OWNER}/${repo}. The workflow will fail without them, whatever this page says about the rest.`
            : undefined,
      })
    }

    return { checks, workflows, publishWorkflow, dispatchable }
  })
}

/**
 * Forget a repo's cached checks.
 *
 * Called right after a request that changes one of the answers — setting the
 * secret, or a CI run landing an image. Without it the checklist would keep
 * showing the pre-action state for up to a minute, which reads as the button
 * having done nothing.
 */
export function forgetRepoChecks(repo: string): void {
  cache.forget(`checks:${repo}`)
}
