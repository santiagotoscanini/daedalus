import { timingSafeEqual } from 'node:crypto'
import { createFileRoute } from '@tanstack/react-router'

// "A new image landed — redeploy this app."
//
// Driven by zot's events extension (stacks/registry): every push to the
// registry POSTs here, and an app goes live within seconds instead of waiting
// up to two minutes for its poll timer. Also accepts a hand-rolled
// {"app":"anansi"} for testing.
//
// This path is OUTSIDE the Pocket ID gate (authBypassRule in
// stacks/daedalus/daedalus.nix) because zot cannot hold a passkey. It carries
// its own auth instead: X-Deploy-Token, shared with the registry through
// stacks/registry/env.sops. Fail-closed — with no token configured the
// endpoint refuses everything rather than silently becoming open.
//
// It can do exactly one thing: start an existing app's deploy unit. The app
// name is validated loosely here (fail fast, useful error) and
// authoritatively in the host trigger, which checks it against a generated
// allowlist before it becomes part of a unit name that root starts. This
// route is not the security boundary.

export const Route = createFileRoute('/api/deploy')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const denied = authFailure(request)
        if (denied) return denied

        const { readDeployStatus } = await import('../lib/deploy')
        return Response.json(await readDeployStatus())
      },

      POST: async ({ request }) => {
        const denied = authFailure(request)
        if (denied) return denied

        const { requestDeploy } = await import('../lib/deploy')
        const { getApp } = await import('../lib/repo/apps')

        let body: Record<string, unknown> = {}
        try {
          body = (await request.json()) as Record<string, unknown>
        } catch {
          return Response.json({ status: 'error', error: 'body must be JSON' }, { status: 400 })
        }

        // zot speaks CloudEvents in BINARY mode: the attributes are HTTP
        // headers (ce-type, ce-id, ce-source…) and the body is the bare data
        // payload — there is no `type` or `data` envelope in the JSON. Verified
        // against a real push:
        //   ce-type: zotregistry.image.updated
        //   body:    { actor, digest, manifest, mediaType, name, reference, request }
        // so the repository is `name` and the tag is `reference`.
        const eventType = request.headers.get('ce-type') ?? asString(body.type) ?? ''

        // zot has NO event-type filter, so deletes arrive here too. Ignore
        // those; let everything else through, because over-triggering is cheap
        // — app-<name>-deploy.service compares digests and no-ops when nothing
        // moved. Better a redundant no-op than a missed release.
        if (/delet|remov/i.test(eventType)) {
          return Response.json({ status: 'ignored', reason: eventType })
        }

        // `name` is zot's field; `app`/`repository` keep hand-rolled calls and
        // any future sender working.
        const data = (
          typeof body.data === 'object' && body.data !== null ? body.data : {}
        ) as Record<string, unknown>
        const raw = [body.app, body.repository, body.name, data.repository, data.name].find(
          (v): v is string => typeof v === 'string' && v.length > 0,
        )

        if (!raw) {
          // Logged rather than silently dropped: this is how we learn the real
          // payload shape. Headers included because CloudEvents binary mode
          // puts the interesting attributes there, not in the body.
          const ce = Object.fromEntries(
            [...request.headers.entries()].filter(([k]) => k.startsWith('ce-')),
          )
          console.warn(
            '[deploy] no repository. ce-headers:',
            JSON.stringify(ce),
            '| body keys:',
            JSON.stringify(Object.keys(body)),
          )
          return Response.json(
            { status: 'error', error: 'no app/repository in payload' },
            { status: 400 },
          )
        }

        const app = repoToApp(raw)

        if (!app) {
          // Namespaced repo — zot's own `cache/*` mirrors land here. NOT an
          // app, and emphatically not the app of the same last segment:
          // taking the final path element would make every GC event on
          // cache/anansi redeploy anansi.
          return Response.json({ status: 'ignored', reason: `not a top-level repo: ${raw}` })
        }

        if (!/^[a-z][a-z0-9-]*$/.test(app)) {
          return Response.json(
            { status: 'error', error: `not a valid app name: '${raw}'` },
            { status: 400 },
          )
        }

        // Unknown or non-deployable repos answer 200/ignored rather than 4xx.
        // This endpoint is a firehose: zot pushes every event here, including
        // for anything in the registry that is not a managed app, and an error
        // status would just invite retries and noise.
        const record = await getApp(app)
        if (!record) {
          return Response.json({ status: 'ignored', reason: `not a managed app: ${app}` })
        }
        if (record.sourceMode === 'local') {
          return Response.json({
            status: 'ignored',
            reason: `${app} builds from source in the flake repo — there is no image to pull`,
          })
        }

        const id = await requestDeploy({
          app,
          reason: eventType || 'registry push',
          actor: request.headers.get('x-forwarded-email') ?? 'registry',
        })

        return Response.json({ status: 'queued', id, app })
      },
    },
  },
})

/**
 * Repo reference → app name, or null when it is not an app repo.
 *
 * Apps live at the top level of the registry (`anansi`), so anything still
 * namespaced after stripping an optional host prefix is something else —
 * zot's `cache/*` sync mirrors above all.
 */
function repoToApp(raw: string): string | null {
  let repo = raw.trim().replace(/^https?:\/\//, '')

  // "registry.toscanini.me/anansi" → "anansi". A first segment containing a
  // dot is a hostname; a first segment without one is a real namespace.
  const first = repo.split('/')[0] ?? ''
  if (repo.includes('/') && first.includes('.')) {
    repo = repo.slice(first.length + 1)
  }

  // Drop any tag or digest suffix.
  repo = repo.split('@')[0] ?? repo
  const colon = repo.lastIndexOf(':')
  if (colon > repo.lastIndexOf('/')) repo = repo.slice(0, colon)

  return repo.includes('/') || repo === '' ? null : repo
}

function asString(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null
}

/** Null when the caller is authorised; otherwise the response to send back. */
function authFailure(request: Request): Response | null {
  const expected = process.env.DEPLOY_HOOK_TOKEN
  if (!expected) {
    return Response.json(
      { status: 'error', error: 'deploy hook is not configured' },
      { status: 503 },
    )
  }
  if (!safeEqual(request.headers.get('x-deploy-token') ?? '', expected)) {
    return Response.json({ status: 'error', error: 'bad or missing token' }, { status: 401 })
  }
  return null
}

/**
 * Constant-time compare. `===` on a secret leaks its length and prefix through
 * timing; irrelevant over a LAN in practice, but this is the one credential
 * standing in front of an unauthenticated path that starts privileged units.
 */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}
