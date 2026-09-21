// `pnpm build`: Vite, with a canary bound to every identity variable, then
// scripts/check-build.mjs under the same environment.
//
// An image is built once and run on every box, so the box's identity must
// not survive the build. Binding a value no box has and then looking for it
// in `dist/` is the only test that says so about the artefact rather than
// about the source: a future `import.meta.env.VITE_*`, a `define`, or a
// plugin that inlines `process.env` would all pass a grep of `src/`.
//
// Both spellings are bound — Vite inlines only the VITE_ ones, and the bare
// ones are what the server reads at run time.

import { spawnSync } from 'node:child_process'

const app = new URL('..', import.meta.url).pathname

const IDENTITY_CANARY = {
  BASE_DOMAIN: 'domain.build-canary.invalid',
  GITHUB_OWNER: 'owner-build-canary',
  REGISTRY_HOST: 'registry.build-canary.invalid',
  GRAFANA_URL: 'https://grafana.build-canary.invalid',
}

const env = { ...process.env }
for (const [name, value] of Object.entries(IDENTITY_CANARY)) {
  env[name] = value
  env[`VITE_${name}`] = value
}

for (const [cmd, args] of [
  ['node_modules/.bin/vite', ['build']],
  [process.execPath, ['scripts/check-build.mjs']],
]) {
  const { status } = spawnSync(cmd, args, { cwd: app, env, stdio: 'inherit' })
  if (status !== 0) process.exit(status ?? 1)
}
