// The registry's small vocabularies, spelled out once: the decoders, the
// validators and the database's CHECK constraints (host/schema.ts) all read
// these tuples, so a value one of them accepts the others do too.

/** `registry`: the box builds and deploys the image. `local`: no box build, no deploy unit. */
export const SOURCE_MODES = ['registry', 'local'] as const
export type SourceMode = (typeof SOURCE_MODES)[number]

/** No gate, traefik forward-auth, or the app as its own OIDC client (AUTH.md). */
export const AUTH_MODES = ['none', 'proxy', 'native'] as const
export type AuthMode = (typeof AUTH_MODES)[number]

/** deploy.sh's verdict on a deploy, from its health check through traefik. */
export const DEPLOY_RESULTS = ['ok', 'failed'] as const
export type DeployResult = (typeof DEPLOY_RESULTS)[number]
