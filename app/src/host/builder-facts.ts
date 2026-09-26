import {
  arrayOf,
  bool,
  type Decoder,
  nullable,
  num,
  obj,
  optional,
  str,
} from '../lib/contract/decode'
import { readSnapshot } from './contract/snapshot'
import { env } from './env'

// The builder's machinery, as daedalus-builder-snapshot publishes it
// (nix/stacks/daedalus/host/builder-snapshot.sh): BuildKit's cache, the scratch
// dataset, the per-app mise caches, whether the egress fence and the push
// credential are in place, and the builder's units. Exit codes, sizes,
// versions and unit states — the script keeps nothing else.
//
// Tolerant like every snapshot reader: a key an older script does not write
// decodes to its "don't know" value, never to a healthy one.

const nn = nullable(num)

const buildkit = obj({
  version: optional(nullable(str), null),
  reachable: optional(bool, false),
  cacheBytes: optional(nn, null),
  reclaimableBytes: optional(nn, null),
})

const storage = obj({
  dataset: optional(str, ''),
  mountpoint: optional(str, ''),
  mounted: optional(bool, false),
  usedBytes: optional(nn, null),
  quotaBytes: optional(nn, null),
})

const unit = obj({
  unit: str,
  active: optional(str, 'unknown'),
  sub: optional(str, ''),
  result: optional(nullable(str), null),
  lastExitAt: optional(nullable(str), null),
})

const factsShape = obj({
  buildkit,
  storage,
  mise: optional(arrayOf(obj({ app: str, bytes: nn })), []),
  // Absent means "not checked", which must not read as loaded or well-formed.
  fence: optional(obj({ loaded: nullable(bool) }), { loaded: null }),
  credential: optional(obj({ wellFormed: nullable(bool) }), { wellFormed: null }),
  units: optional(arrayOf(unit), []),
})

export type BuilderFacts = typeof factsShape extends Decoder<infer T> ? T : never
export type BuilderUnit = BuilderFacts['units'][number]

const NO_FACTS: BuilderFacts = {
  buildkit: { version: null, reachable: false, cacheBytes: null, reclaimableBytes: null },
  storage: { dataset: '', mountpoint: '', mounted: false, usedBytes: null, quotaBytes: null },
  mise: [],
  fence: { loaded: null },
  credential: { wellFormed: null },
  units: [],
}

/**
 * The snapshot, or why there is none. `facts` is null whenever the file is
 * missing, broken or stale: a reading the timer stopped refreshing is exactly
 * the plausible-looking answer the page must not show as current.
 */
export type BuilderSnapshot = {
  facts: BuilderFacts | null
  /** Why `facts` is null: never written, unreadable, or stopped refreshing. */
  missing: 'absent' | 'broken' | 'stale' | null
  generatedAt: string | null
}

export async function readBuilderFacts(): Promise<BuilderSnapshot> {
  const s = await readSnapshot({
    path: env.get('BUILDER_FACTS_PATH'),
    decoder: factsShape,
    fallback: NO_FACTS,
    acceptVersions: [1],
    // Written every minute; three intervals is a producer that has stopped.
    maxAgeMs: 3 * 60_000,
  })
  const missing = !s.available ? (s.error === null ? 'absent' : 'broken') : s.stale ? 'stale' : null
  return { facts: missing === null ? s.data : null, missing, generatedAt: s.generatedAt }
}
