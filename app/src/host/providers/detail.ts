import type { Ctx } from '../../core/ctx'
import { decode } from '../../lib/contract/decode'
import {
  lemonadeBackendsDecoder,
  lemonadeDownloadsDecoder,
  type ProviderBackend,
  type ProviderDownload,
  type ProviderKind,
} from '../../lib/providers/kinds'
import { lemonadeFigures, type ModelFigures } from '../../lib/providers/metrics'

// The second half of reading a provider: what it is fetching, which
// runtimes it has installed, and what each of its models has managed.
//
// Split from ./read.ts because the two have different lifetimes and
// different readers. The catalog and the health are what the GATEWAY SYNC
// needs too, so ./read.ts remembers them a minute. These three are for
// the page alone and one of them — a download's percentage — is worthless
// if it is a minute old, so nothing here is memoized and nothing here is on
// the sync's path.
//
// Every read is best-effort: a provider that answers its catalog but not
// its /metrics is a provider with no figures, not a broken page.

export type ProviderDetail = {
  downloads: ProviderDownload[]
  backends: ProviderBackend[]
  /** By the provider's model id. Absent means "never served since it started". */
  figures: Record<string, ModelFigures>
}

export const NO_DETAIL: ProviderDetail = { downloads: [], backends: [], figures: {} }

export async function readProviderDetail(
  ctx: Ctx,
  kind: ProviderKind,
  base: string,
): Promise<ProviderDetail> {
  // subgen has one model, no catalog and no exposition; there is nothing
  // here for it to answer.
  if (kind !== 'lemonade') return NO_DETAIL
  const root = base.replace(/\/+$/, '')
  const [downloads, info, metrics] = await Promise.all([
    ctx.http.getJson<unknown>(`${root}/api/v1/downloads`),
    ctx.http.getJson<unknown>(`${root}/api/v1/system-info`),
    ctx.http.getText(`${root}/metrics`),
  ])
  return {
    downloads:
      downloads === null ? [] : safely(() => decode(lemonadeDownloadsDecoder, downloads), []),
    backends: info === null ? [] : safely(() => decode(lemonadeBackendsDecoder, info), []),
    figures: metrics === null ? {} : safely(() => lemonadeFigures(metrics), {}),
  }
}

/** A provider that answered something unexpected costs its own panel, not the page. */
function safely<T>(read: () => T, fallback: T): T {
  try {
    return read()
  } catch {
    return fallback
  }
}
