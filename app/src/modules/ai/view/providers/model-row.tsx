// One model inside a kind: the one in the slot, the alternatives, and the
// residency verbs that move between them.

import { useRouter } from '@tanstack/react-router'
import { MONO } from '../../../../components/tokens'
import { Button } from '../../../../components/ui/button'
import { useVerbRequest } from '../../../../components/verb-request'
import { Chip, Measures, Pulse } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { num } from '../../../../lib/format'
import {
  fetchProviderActionFn,
  loadProviderModelFn,
  unloadProviderModelFn,
} from '../../../../server/providers'
import type { CatalogEntry, ProviderMachine } from '../../data/providers'

/** How long a verb may take on the machine: a cold 12B model is read off a disk and pushed across PCIe. */
const OUTCOME_WITHIN_MS = 150_000

/** A residency verb on `m`, followed to the outcome its agent reports. */
function useResidency(m: ProviderMachine) {
  const router = useRouter()
  return useVerbRequest({
    get: (request) => fetchProviderActionFn({ data: { machine: m.machine, request } }),
    waitMs: OUTCOME_WITHIN_MS,
    onSettle: () => {
      void router.invalidate()
    },
  })
}

/* The model in the slot. Given real weight — it is the answer to the kind's
   question, and everything below it is an alternative. */
const HERO = 'group/hero rounded-[9px] bg-raised px-[0.6rem] py-[0.5rem]'
const HERO_NAME = 'min-w-0 truncate text-[0.85rem] font-semibold text-foreground'

/* One of the other models of this kind — one click from the slot. */
const ALT =
  'group/alt flex min-w-0 items-center gap-[0.6rem] rounded-[7px] px-[0.6rem] py-[0.22rem] hover:bg-raised max-[46rem]:flex-wrap'
const ALT_NAME = 'min-w-0 truncate text-[0.8rem] text-subdued'
const ALT_META =
  'ml-auto flex items-baseline gap-x-[0.9rem] gap-y-0 whitespace-nowrap text-[0.7rem] text-muted-foreground tabular-nums max-[46rem]:ml-0'

/* The row's button: quiet until wanted. The row is information first and an
   action second, and a column of always-lit buttons would compete with the
   model that is actually running. */
const QUIET_BTN =
  'h-auto flex-none px-[0.5rem] py-[0.15rem] text-[0.68rem] text-subdued opacity-45 transition-opacity duration-[0.12s] focus-visible:opacity-100'

/** What the gateway calls this model, if it carries it at all. */
export function GatewayName({ model }: { model: CatalogEntry }) {
  if (model.routed !== null) {
    return <span className={`${MONO} text-success`}>routed as {model.routed}</span>
  }
  if (!model.downloaded) return <span>not on disk</span>
  if (model.offerable) return <span className={MONO}>{model.alias} · awaiting the sync</span>
  return <span>not offered</span>
}

/** The model in the slot: what it is, and what it has done. */
export function ModelHero({ model, m }: { model: CatalogEntry; m: ProviderMachine }) {
  const f = model.figures
  const some = (n: number | null | undefined) => n != null && n > 0
  // Only the figures that say something. Every one of these is emitted for
  // every loaded model, so an embedding model that has never been asked for
  // a token still reports 0.0 tok/s and 0 ms to first token — and a TTS
  // model would report those forever, because they do not mean anything for
  // it. Rendered, that is a row of noughts under every kind, which reads as
  // broken instrumentation rather than as an idle model. Zero is dropped
  // rather than shown because each of these is cumulative-or-latest:
  // nothing has happened yet, which is what an absent figure already says.
  const stats =
    f === null
      ? []
      : [
          { k: 'throughput', v: `${(f.tps ?? 0).toFixed(1)} tok/s`, on: some(f.tps) },
          { k: 'first token', v: `${num(f.ttftMs)} ms`, on: some(f.ttftMs) },
          { k: 'requests', v: num(f.requests), on: some(f.requests) },
          { k: 'tokens out', v: num(f.outputTokens), on: some(f.outputTokens) },
          { k: 'tokens in', v: num(f.inputTokens), on: some(f.inputTokens) },
        ].filter((x) => x.on)

  return (
    <div className={HERO}>
      {/* Name and action on one line, attributes on the next: at this width
          they cannot share a line without the name being truncated to
          nothing, and the name is the part being identified. */}
      <div className="flex min-w-0 items-center gap-[0.5rem]">
        <Pulse on tone="accent" />
        <span className={HERO_NAME}>{model.id}</span>
        {m.manageable && <EvictButton model={model} m={m} />}
      </div>
      <div className="mt-[0.35rem] flex flex-wrap items-center gap-[0.25rem]">
        {model.recipe !== null && <Chip tone="info">{model.recipe}</Chip>}
        {model.loaded?.device != null && <Chip tone="ok">{model.loaded.device}</Chip>}
        {model.loaded?.maxContext != null && (
          <Chip>{num(model.loaded.maxContext / 1024)}k ctx</Chip>
        )}
        {model.sizeGb !== null && <Chip>{num(model.sizeGb, 1)} GB</Chip>}
        {model.supportsTools && <Chip>tools</Chip>}
        {model.supportsVision && <Chip>vision</Chip>}
        {model.loaded?.pinned === true && <Chip tone="warn">pinned</Chip>}
        <span className="ml-[0.2rem] text-[0.7rem] text-muted-foreground">
          <GatewayName model={model} />
        </span>
      </div>
      {stats.length > 0 && (
        <div className="mt-[0.55rem]">
          <Measures items={stats} />
        </div>
      )}
    </div>
  )
}

/**
 * A model that is not in the slot, and the button that puts it there.
 *
 * Shows what it managed last time it ran, which is the whole basis for
 * choosing between two models you already have on disk.
 */
export function ModelAlt({
  model,
  m,
  replacing,
}: {
  model: CatalogEntry
  m: ProviderMachine
  replacing: CatalogEntry | null
}) {
  const { busy, outcome, start } = useResidency(m)
  const error =
    outcome !== null && outcome.state !== 'running' && outcome.state !== 'done'
      ? outcome.detail
      : null
  const verb = replacing === null ? 'Load' : 'Switch'

  return (
    <li className={ALT}>
      <span className={ALT_NAME} title={model.id}>
        {model.id}
      </span>
      <span className={ALT_META}>
        <GatewayName model={model} />
        {model.sizeGb !== null && <span>{num(model.sizeGb, 1)} GB</span>}
        {/* Its throughput last time it ran — the one number that actually
            decides between two models you already have. Requests are
            dropped here: they say how much you have used it, not how well
            it works, and the row has no space for both. */}
        {model.figures?.tps != null && model.figures.tps > 0 && (
          <span>{model.figures.tps.toFixed(0)} tok/s</span>
        )}
      </span>
      {error !== null && (
        <span className="text-[0.7rem] text-danger" title={error}>
          failed
        </span>
      )}
      {m.manageable && model.downloaded && (
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={cn(QUIET_BTN, 'group-hover/alt:opacity-100')}
          disabled={busy}
          title={
            replacing === null
              ? `Load ${model.id}`
              : `Put ${replacing.id} down and load ${model.id}`
          }
          onClick={() => {
            start(() =>
              loadProviderModelFn({
                data: {
                  machine: m.machine,
                  kind: m.kind,
                  model: model.id,
                  replacing: replacing?.id ?? null,
                  // Carry the incumbent's pinning forward rather than
                  // silently changing whether the slot survives the next
                  // squeeze.
                  pinned: replacing?.loaded?.pinned ?? false,
                },
              }),
            )
          }}
        >
          {busy ? `${verb}ing…` : verb}
        </Button>
      )}
    </li>
  )
}

/**
 * Hands the accelerator memory and the file handle back.
 *
 * The file-handle half is the one that comes up: a model that is loaded
 * cannot be replaced or re-fetched, so a stuck download is often just this.
 */
function EvictButton({ model, m }: { model: CatalogEntry; m: ProviderMachine }) {
  const { busy, start } = useResidency(m)
  return (
    // Quieter still than Switch: a lit Evict button beside every resident
    // model competed with the models themselves, and evicting is a thing
    // you do occasionally rather than a thing you read.
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(QUIET_BTN, 'ml-auto py-[0.18rem] opacity-40 group-hover/hero:opacity-100')}
      disabled={busy}
      title={`Unload ${model.id}, leaving this slot empty`}
      onClick={() => {
        start(() =>
          unloadProviderModelFn({ data: { machine: m.machine, kind: m.kind, model: model.id } }),
        )
      }}
    >
      {busy ? 'Evicting…' : 'Evict'}
    </Button>
  )
}
