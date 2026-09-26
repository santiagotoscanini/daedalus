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
// Read per call, like every other row: nothing here is cached at module scope,
// which is what a build-time constant was.

export function readSite(e: Env = env): Site {
  return siteFrom({
    baseDomain: e.get('BASE_DOMAIN'),
    owner: e.get('GITHUB_OWNER'),
    registryHost: e.get('REGISTRY_HOST'),
    grafanaUrl: e.get('GRAFANA_URL'),
  })
}
