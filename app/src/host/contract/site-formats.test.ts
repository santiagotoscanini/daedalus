import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { renderSiteFile } from '../../core/site/file'
import { REGISTRY_SCHEMA_VERSION } from '../../lib/contract/version'
import { NODES_SCHEMA_VERSION, parseNodesFile, renderNodesFile } from '../../lib/nodes-file'
import { renderRegistryFile } from '../../lib/registry-file'
import { decodeRegistryFile } from '../nix-manifest'
import { decodeSiteDocument } from './domains/site-doc'

// The site-format samples, read through the real readers.
//
// `site-formats/` at the repository root holds one directory per document per
// schema version: `site/v<N>/` is a whole site directory whose site.json is
// at version N, `apps/v<N>/apps.json` is the registry and
// `nodes/v<N>/nodes.json` the nodes document at version N. The nix
// side reads the same files (`nix/tests/site-formats.nix`, in `nix flake check`):
// a sample is the one artefact both halves of the contract are held to, so
// a reader that drifts from the writer fails here AND there, not on a box.
//
// What is asserted, per sample: the current reader accepts it, the current
// renderer's output of what it read decodes to the same document (the round
// trip every Apply is), and its version is one the reader claims. What is
// asserted once: there is a sample for the version the writer emits today,
// so a bump that forgets its sample fails before the old one is deleted.
//
// Each document has ONE accepted version today (for the registry,
// lib/contract/version.ts and nix/platform/lib/registry-lib.nix; the site and
// nodes readers name their own). A migration, when one exists, gets its case here: read
// the old sample, migrate, and compare against the new sample.

// vitest runs from app/, like every other path-reading test here. In the dev
// container app/ is mounted alone at /app and the whole engine read-only at
// /engine, so that is looked at next. Neither is a failure, never a skip: a
// skipped sample test would hide the contract it exists to hold.
function siteFormatsDir(): string {
  const candidates = [resolve(process.cwd(), '../site-formats'), '/engine/site-formats']
  const found = candidates.find((dir) => existsSync(dir))
  if (found === undefined) {
    throw new Error(`site-format samples not found at ${candidates.join(' or ')}`)
  }
  return found
}
const SAMPLES = siteFormatsDir()

/** `v3` → 3, for the directories under one document's sample root. */
function versions(doc: 'site' | 'apps' | 'nodes'): number[] {
  return readdirSync(join(SAMPLES, doc))
    .map((d) => /^v(\d+)$/.exec(d)?.[1])
    .filter((v): v is string => v !== undefined)
    .map(Number)
    .sort((a, b) => a - b)
}

const parse = (path: string): unknown => JSON.parse(readFileSync(path, 'utf8'))

/** The site document's current version — the only one `decodeSiteDocument` names. */
const SITE_SCHEMA_VERSION = 1

describe('site.json samples', () => {
  it('exist for the version the writer emits', () => {
    expect(versions('site')).toContain(SITE_SCHEMA_VERSION)
  })

  for (const v of versions('site')) {
    it(`v${String(v)} decodes, and survives the render the next Apply would be`, () => {
      const raw = parse(join(SAMPLES, 'site', `v${String(v)}`, 'site.json')) as Record<
        string,
        unknown
      >
      expect(raw.schemaVersion).toBe(v)
      const doc = decodeSiteDocument(raw)
      expect(doc.schemaVersion).toBe(SITE_SCHEMA_VERSION)
      expect(decodeSiteDocument(JSON.parse(renderSiteFile(doc)))).toEqual(doc)
    })
  }
})

describe('apps.json samples', () => {
  it('exist for the version the writer emits', () => {
    expect(versions('apps')).toContain(REGISTRY_SCHEMA_VERSION)
  })

  for (const v of versions('apps')) {
    it(`v${String(v)} decodes, and survives the render the next Apply would be`, () => {
      const raw = parse(join(SAMPLES, 'apps', `v${String(v)}`, 'apps.json')) as Record<
        string,
        unknown
      >
      expect(raw.schemaVersion).toBe(v)
      const registry = decodeRegistryFile(raw)
      expect(registry.schemaVersion).toBe(REGISTRY_SCHEMA_VERSION)
      expect(Object.keys(registry.apps).length).toBeGreaterThan(0)
      expect(decodeRegistryFile(JSON.parse(renderRegistryFile(registry)))).toEqual(registry)
    })
  }

  it('is the same file the site sample carries', () => {
    // The site sample is a whole site directory, so it carries an apps.json
    // of its own: a COPY of the current registry sample, because a link
    // would not survive the store copy a nix path literal makes of the
    // directory. Two copies that may not disagree, and this is what says so
    // (nix/tests/site-formats.nix asserts the same).
    const linked = parse(join(SAMPLES, 'site', `v${String(SITE_SCHEMA_VERSION)}`, 'apps.json'))
    const own = parse(join(SAMPLES, 'apps', `v${String(REGISTRY_SCHEMA_VERSION)}`, 'apps.json'))
    expect(linked).toEqual(own)
  })
})

describe('nodes.json samples', () => {
  it('exist for the version the writer emits', () => {
    expect(versions('nodes')).toContain(NODES_SCHEMA_VERSION)
  })

  for (const v of versions('nodes')) {
    it(`v${String(v)} decodes, and is byte-identical to its own render`, () => {
      const path = join(SAMPLES, 'nodes', `v${String(v)}`, 'nodes.json')
      const raw = parse(path) as Record<string, unknown>
      expect(raw.schemaVersion).toBe(v)
      const doc = parseNodesFile(raw)
      expect(doc.nodes.length).toBeGreaterThan(0)
      // The sample is what an Apply writes, so the writer must reproduce
      // it exactly — the nix side (nix/tests/site-formats.nix) reads this file.
      const rendered = renderNodesFile(
        doc.nodes.map((n) => ({
          ...n,
          providers: Object.fromEntries(
            Object.entries(n.providers).map(([k, p]) => [k, { port: p.port, offer: true }]),
          ),
        })),
      )
      expect(rendered).toBe(readFileSync(path, 'utf8'))
    })
  }
})
