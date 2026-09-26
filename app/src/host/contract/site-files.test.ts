import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderSiteFile } from '../../core/site/file'
import { REGISTRY_SCHEMA_VERSION } from '../../lib/contract/version'
import { NODES_SCHEMA_VERSION, parseNodesFile, renderNodesFile } from '../../lib/nodes-file'
import { renderRegistryFile } from '../../lib/registry-file'
import { decodeRegistryFile } from '../nix-manifest'
import { decodeSiteDocument } from './domains/site-doc'

// The example host's site/ files, read through the real readers.
//
// `example-host/site/` is the host a new operator starts from AND the one
// sample of each site/ document the app and nix are both held to: `nix flake
// check` evaluates the example host from the same files (checks.example-host
// in flake.nix), so a reader that drifts from the writer fails here AND
// there, not on a box.
//
// What is asserted, per document: the app's reader accepts it, its version is
// the one the writer emits today, and the writer's render of what was read
// decodes to the same document (the round trip every Apply is). When a
// format's version changes and old files must stay readable, the OLD
// version's sample gets a folder of its own then, with a migration case here.

// vitest runs from app/, like every other path-reading test here. In the dev
// container app/ is mounted alone at /app and the whole engine read-only at
// /engine, so that is looked at next. Neither is a failure, never a skip: a
// skipped test would hide the contract it exists to hold.
function siteDir(): string {
  const candidates = [resolve(process.cwd(), '../example-host/site'), '/engine/example-host/site']
  const found = candidates.find((dir) => existsSync(dir))
  if (found === undefined) {
    throw new Error(`example-host/site not found at ${candidates.join(' or ')}`)
  }
  return found
}
const SITE = siteDir()

const parse = (file: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(SITE, file), 'utf8')) as Record<string, unknown>

/** The site document's current version — the only one `decodeSiteDocument` names. */
const SITE_SCHEMA_VERSION = 1

describe('example-host/site', () => {
  it('site.json decodes at the current version and survives the next Apply’s render', () => {
    const raw = parse('site.json')
    expect(raw.schemaVersion).toBe(SITE_SCHEMA_VERSION)
    const doc = decodeSiteDocument(raw)
    expect(doc.schemaVersion).toBe(SITE_SCHEMA_VERSION)
    expect(decodeSiteDocument(JSON.parse(renderSiteFile(doc)))).toEqual(doc)
  })

  it('apps.json decodes at the current version and survives the next Apply’s render', () => {
    const raw = parse('apps.json')
    expect(raw.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
    const registry = decodeRegistryFile(raw)
    expect(registry.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
    expect(Object.keys(registry.apps).length).toBeGreaterThan(0)
    expect(decodeRegistryFile(JSON.parse(renderRegistryFile(registry)))).toEqual(registry)
  })

  it('nodes.json decodes at the current version and survives the next Apply’s render', () => {
    const raw = parse('nodes.json')
    expect(raw.schemaVersion).toBe(NODES_SCHEMA_VERSION)
    const doc = parseNodesFile(raw)
    expect(doc.nodes.length).toBeGreaterThan(0)
    // The writer takes every provider with its offer flag; the file holds
    // the offered ones only, so each one read back is offered.
    const rendered = renderNodesFile(
      doc.nodes.map((n) => ({
        ...n,
        providers: Object.fromEntries(
          Object.entries(n.providers).map(([k, p]) => [k, { port: p.port, offer: true }]),
        ),
      })),
    )
    expect(parseNodesFile(JSON.parse(rendered))).toEqual(doc)
  })
})
