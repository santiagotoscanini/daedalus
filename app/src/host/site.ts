import { type Site, siteFrom } from '../lib/site'
import { type Env, env } from './env'

// The one server-side reader of the box's identity.
//
// The container env is the source, and the only one. `/export/site.json`
// carries the domain and the owner too, but it is an async file read that can
// be missing or a version behind, it has no registry HOST (only a URL), and
// nix binds both from the same evaluation — so a second reader would buy a
// precedence rule and no fact. `/site/site.json` is the wrong generation
// altogether: it holds what the operator last saved, which between an edit
// and an Apply is not what traefik, the registry and DNS are serving.
//
// Each fact has two names. The bare one is what the config binds; the VITE_
// one is what it bound while Vite inlined these, and is read second so a box
// whose nix config predates the rename keeps its identity. Nothing reads
// `import.meta.env` for them any more, so the prefix no longer means anything.
//
// Read per call, like every other row: nothing here is cached at module scope,
// which is what a build-time constant was.

export function readSite(e: Env = env): Site {
  return siteFrom({
    baseDomain: e.get('BASE_DOMAIN') ?? e.get('VITE_BASE_DOMAIN'),
    owner: e.get('GITHUB_OWNER') ?? e.get('VITE_GITHUB_OWNER'),
    registryHost: e.get('REGISTRY_HOST') ?? e.get('VITE_REGISTRY_HOST'),
    grafanaUrl: e.get('GRAFANA_URL') ?? e.get('VITE_GRAFANA_URL'),
  })
}
