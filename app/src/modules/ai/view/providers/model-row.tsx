// One model of a kind, as a row of the model table: the one in the slot or an
// alternative, and the residency verb that moves between them.

import { useRouter } from '@tanstack/react-router'
import { Button } from '../../../../components/ui/button'
import { useVerbRequest } from '../../../../components/verb-request'
import { Chip, Pulse } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { compact, DASH, num } from '../../../../lib/format'
import {
  fetchProviderActionFn,
  loadProviderModelFn,
  unloadProviderModelFn,
} from '../../../../server/providers'
import type { CatalogEntry, ProviderMachine } from '../../data/providers'
import { CELL_MONO, CELL_NAME, CELL_QUIET, CELL_SUB, PHONE_SUB, TABLE_ROW } from '../shared'

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

/* One grid for the head and every row. The figures step away first (what a
   model managed), then the gateway name and size, leaving name and verb. */
export const MODEL_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,2.4fr)_minmax(0,1.5fr)_4rem_3.5rem_6.5rem_4.5rem_4rem_5.5rem]',
  '@max-[62rem]/table:grid-cols-[minmax(0,2fr)_minmax(0,1.4fr)_4rem_3.5rem_5.5rem]',
  '@max-[38rem]/table:grid-cols-[minmax(0,1fr)_5.5rem]',
)
/** A column that steps away under 62rem. */
export const NARROW = '@max-[62rem]/table:hidden'
/** A column that steps away under 40rem. */
export const NARROWEST = '@max-[38rem]/table:hidden'

/** Names wrap on a phone rather than truncate: the name is what identifies the row. */
const WRAP_PHONE =
  '@max-[38rem]/table:whitespace-normal @max-[38rem]/table:[overflow-wrap:anywhere]'

const NUM = cn(CELL_QUIET, 'text-right')
/** A figure not there yet: a quiet dash, so the column still reads as a column. */
const NONE = <span className="text-muted-foreground/50">{DASH}</span>

/* The row's verb: quiet until the row is wanted. The row is information first
   and an action second, and a column of always-lit buttons would compete with
   the model that is actually running. */
const QUIET_BTN =
  'ml-auto h-7 flex-none px-2.5 text-[0.75rem] text-subdued opacity-70 transition-opacity duration-[0.12s] group-hover/row:opacity-100 focus-visible:opacity-100 [@media(hover:none)]:opacity-100'

/**
 * What the gateway calls this model, if it carries it at all.
 *
 * The column is headed "Gateway name", so a routed model is just its name in
 * quiet mono — routed is the norm. Only the ways a model is NOT routed get words.
 */
export function GatewayName({ model }: { model: CatalogEntry }) {
  if (model.routed !== null) {
    return (
      <span className={CELL_MONO} title={`routed as ${model.routed}`}>
        {model.routed}
      </span>
    )
  }
  if (!model.downloaded) return <span className={CELL_QUIET}>not on disk</span>
  if (model.offerable) {
    return (
      <span className={cn(CELL_MONO, 'text-info')} title="offered, not yet written by the sync">
        {model.alias} · awaiting the sync
      </span>
    )
  }
  return <span className={CELL_QUIET}>not offered</span>
}

/** What the columns hidden on a phone held, as the muted second line. */
function phoneLine(model: CatalogEntry): string {
  const f = model.figures
  const gateway =
    model.routed !== null
      ? model.routed
      : !model.downloaded
        ? 'not on disk'
        : model.offerable
          ? `${model.alias} · awaiting the sync`
          : 'not offered'
  return [
    gateway,
    model.sizeGb === null ? null : `${num(model.sizeGb, 1)} GB`,
    f?.tps != null && f.tps > 0 ? `${f.tps.toFixed(1)} tok/s` : null,
    f?.ttftMs != null && f.ttftMs > 0 ? `${num(f.ttftMs)} ms first token` : null,
    f?.requests != null && f.requests > 0 ? `${num(f.requests)} req` : null,
  ]
    .filter((x) => x !== null)
    .join(' · ')
}

/**
 * The runtime and what the slot holds it with, under the name.
 *
 * Muted text rather than a pill per fact: the recipe repeats down the table.
 * Pinned is the exception — it changes what Switch has to do — so it alone is
 * a chip, a neutral one: it is a deliberate setting, not something wrong.
 */
function Attributes({ model }: { model: CatalogEntry }) {
  const parts = [
    model.loaded === null ? null : 'loaded',
    model.recipe,
    model.loaded?.device ?? null,
    model.loaded?.maxContext != null ? `${num(model.loaded.maxContext / 1024)}k ctx` : null,
    model.supportsTools ? 'tools' : null,
    model.supportsVision ? 'vision' : null,
  ].filter((x): x is string => x !== null)
  if (parts.length === 0 && model.loaded?.pinned !== true) return null
  return (
    <p className={cn(CELL_SUB, 'flex flex-wrap items-center gap-x-2 gap-y-1 whitespace-normal')}>
      <span>{parts.join(' · ')}</span>
      {model.loaded?.pinned === true && <Chip>pinned</Chip>}
    </p>
  )
}

/**
 * One model.
 *
 * The one in the slot carries the pulse and the primary ink; the others are a
 * step quieter, one click from the slot. Every figure is the model's last
 * reading — they survive an eviction — so the alternatives show what they
 * managed last time, which is the whole basis for choosing between two models
 * already on disk. A figure that is zero is blank: every one of these is
 * emitted for every loaded model, so an embedding model never asked for a
 * token reports 0.0 tok/s forever, and a row of noughts reads as broken
 * instrumentation rather than an idle model.
 */
export function ModelRow({
  model,
  m,
  replacing,
}: {
  model: CatalogEntry
  m: ProviderMachine
  /** The resident model this row would replace, or null for the resident row itself and an empty slot. */
  replacing: CatalogEntry | null
}) {
  const resident = model.loaded !== null
  const f = model.figures
  const some = (n: number | null | undefined): n is number => n != null && n > 0
  const tokens = (f?.inputTokens ?? 0) + (f?.outputTokens ?? 0)

  return (
    <li className={cn(MODEL_GRID, TABLE_ROW)}>
      <div className="min-w-0">
        <p className="m-0 flex min-w-0 items-center gap-2">
          {resident ? (
            <Pulse on tone="accent" />
          ) : (
            <span aria-hidden="true" className="size-[7px] flex-none" />
          )}
          <span
            className={cn(CELL_NAME, WRAP_PHONE, !resident && 'text-subdued [font-weight:450]')}
            title={model.id}
          >
            {model.id}
          </span>
        </p>
        <div className="pl-[15px]">
          <Attributes model={model} />
          <p className={PHONE_SUB}>{phoneLine(model)}</p>
        </div>
      </div>
      <span className="flex min-w-0 @max-[38rem]/table:hidden">
        <GatewayName model={model} />
      </span>
      <span className={cn(NUM, '@max-[38rem]/table:hidden')}>
        {model.sizeGb === null ? NONE : num(model.sizeGb, 1)}
      </span>
      <span className={cn(NUM, '@max-[38rem]/table:hidden', resident && 'text-foreground')}>
        {some(f?.tps) ? f.tps.toFixed(1) : NONE}
      </span>
      <span className={cn(NUM, NARROW)}>{some(f?.ttftMs) ? num(f.ttftMs) : NONE}</span>
      <span className={cn(NUM, NARROW)}>{some(f?.requests) ? num(f.requests) : NONE}</span>
      <span
        className={cn(NUM, NARROW)}
        title={
          tokens > 0
            ? `${num(f?.inputTokens ?? 0)} in · ${num(f?.outputTokens ?? 0)} out`
            : undefined
        }
      >
        {tokens > 0 ? compact(tokens) : NONE}
      </span>
      <span className="flex min-w-0 items-center justify-end gap-2">
        {m.manageable &&
          (resident ? (
            <EvictButton model={model} m={m} />
          ) : (
            model.downloaded && <LoadButton model={model} m={m} replacing={replacing} />
          ))}
      </span>
    </li>
  )
}

/** Puts `model` in the slot, putting the incumbent down first. */
function LoadButton({
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
    <>
      {error !== null && (
        <span className="text-[0.72rem] text-danger" title={error}>
          failed
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(QUIET_BTN, (busy || error !== null) && 'opacity-100')}
        disabled={busy}
        title={
          replacing === null ? `Load ${model.id}` : `Put ${replacing.id} down and load ${model.id}`
        }
        onClick={() => {
          start(() =>
            loadProviderModelFn({
              data: {
                machine: m.machine,
                kind: m.kind,
                model: model.id,
                replacing: replacing?.id ?? null,
                // Carry the incumbent's pinning forward rather than silently
                // changing whether the slot survives the next squeeze.
                pinned: replacing?.loaded?.pinned ?? false,
              },
            }),
          )
        }}
      >
        {busy ? `${verb}ing…` : verb}
      </Button>
    </>
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
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(QUIET_BTN, busy && 'opacity-100')}
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
