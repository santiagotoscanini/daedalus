// The model table: one machine's catalog, grouped by kind.

import { CAPTION, FOOT, MONO } from '../../../../components/tokens'
import { cn } from '../../../../lib/cn'
import { compact, DASH, num } from '../../../../lib/format'
import { MODE_WORD } from '../../../../lib/providers/policy'
import type { CatalogEntry, ProviderMachine } from '../../data/providers'
import { TABLE, TABLE_EMPTY, TABLE_HEAD, TABLE_ROW, TableGroup, TableSection } from '../shared'
import { MODEL_GRID, ModelRow, NARROW, NARROWEST } from './model-row'

/* ── the model table ──────────────────────────────────────────────────── */

/* Only present mid-download, so it stands above the table — tinted, not coloured. */
const DOWNLOADS = 'm-0 mb-3 flex list-none flex-col gap-1 p-0'
const DOWNLOAD =
  'flex gap-2.5 rounded-lg bg-foreground/[0.04] px-3 py-1.5 text-[0.75rem] text-subdued'

/* Build numbers for the runtimes named on the models. One line: that is all
   they are worth once the runtime itself is stated per model. */
const BUILDS = 'm-0 flex flex-wrap gap-x-4 gap-y-1 text-[0.75rem] text-muted-foreground'

/* A kind with nothing in its slot: the one row that is a state, not a model. */
const SLOT_EMPTY = 'col-span-full text-[0.8rem]'

type Group = { mode: CatalogEntry['mode']; models: CatalogEntry[] }

/** The catalog by kind: what is resident first, then what has been used most. */
function groupsOf(models: CatalogEntry[]): Group[] {
  const by = new Map<CatalogEntry['mode'], CatalogEntry[]>()
  for (const m of models) by.set(m.mode, [...(by.get(m.mode) ?? []), m])
  return (
    [...by]
      .map(([mode, list]) => ({
        mode,
        models: [...list].sort(
          (a, b) =>
            Number(b.loaded !== null) - Number(a.loaded !== null) ||
            (b.figures?.requests ?? 0) - (a.figures?.requests ?? 0) ||
            a.id.localeCompare(b.id),
        ),
      }))
      // Kinds with a real choice to make come first; a singleton is a
      // statement of fact and can sit at the bottom.
      .sort((a, b) => b.models.length - a.models.length || a.mode.localeCompare(b.mode))
  )
}

const word = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)

/**
 * The aggregate for a whole kind, on its group band: how many models, how much
 * disk, and what they have managed between them. Abbreviated — these are a
 * sense of scale rather than quantities.
 */
function aggregateOf(group: Group): string {
  const sum = (pick: (x: CatalogEntry) => number | null | undefined) =>
    group.models.reduce((n, x) => n + (pick(x) ?? 0), 0)
  const size = sum((x) => x.sizeGb)
  const requests = sum((x) => x.figures?.requests)
  const tokens = sum((x) => (x.figures?.inputTokens ?? 0) + (x.figures?.outputTokens ?? 0))
  return [
    group.models.length === 1 ? '1 model' : `${String(group.models.length)} models`,
    size > 0 ? `${num(size, 1)} GB` : null,
    requests > 0 ? `${compact(requests)} req` : null,
    tokens > 0 ? `${compact(tokens)} tok` : null,
  ]
    .filter((x) => x !== null)
    .join(' · ')
}

/**
 * One kind: a group band, the model in its slot, then the alternatives.
 *
 * One model of each kind may be resident, so a kind's models are competing
 * answers to one question rather than a flat list — the band is that question,
 * and the row with the pulse is today's answer.
 */
function ModelKind({ group, m }: { group: Group; m: ProviderMachine }) {
  const resident = group.models.find((x) => x.loaded !== null) ?? null
  const others = group.models.filter((x) => x !== resident)
  return (
    <>
      <TableGroup title={word(MODE_WORD[group.mode])} note={aggregateOf(group)} />
      {resident === null ? (
        <li className={cn(MODEL_GRID, TABLE_ROW, 'min-h-11')}>
          {/* An empty slot is only worth calling out where a slot is a thing:
              a provider the box cannot load into has no empty slot, just
              nothing resident. */}
          <span className={cn(SLOT_EMPTY, m.manageable ? 'text-warning' : 'text-muted-foreground')}>
            {m.manageable
              ? 'Slot free: nothing loaded. The next request cold-loads one.'
              : 'Nothing resident right now.'}
          </span>
        </li>
      ) : (
        <ModelRow model={resident} m={m} replacing={null} />
      )}
      {others.map((x) => (
        <ModelRow key={x.id} model={x} m={m} replacing={resident} />
      ))}
    </>
  )
}

/** The labels row; numeric columns right-aligned, units in the label. */
function ModelHead() {
  return (
    <li aria-hidden="true" className={cn(MODEL_GRID, TABLE_HEAD, '@max-[38rem]/table:hidden')}>
      <span>Model</span>
      <span className={NARROWEST}>Gateway name</span>
      <span className={cn(NARROWEST, 'text-right')}>Size, GB</span>
      <span className={cn(NARROWEST, 'text-right')}>tok/s</span>
      <span className={cn(NARROW, 'text-right')}>First token, ms</span>
      <span className={cn(NARROW, 'text-right')}>Requests</span>
      <span className={cn(NARROW, 'text-right')}>Tokens</span>
      <span />
    </li>
  )
}

/** The machine's catalog by kind, with anything mid-download above it and the runtime builds under it. */
export function ModelsBoard({ m }: { m: ProviderMachine }) {
  const groups = groupsOf(m.models)
  const { downloads, backends } = m.detail
  const onDisk = m.models.filter((x) => x.downloaded)
  const routed = m.models.filter((x) => x.routed !== null).length
  // A provider that reports no size for anything is not a provider holding
  // nought gigabytes — subgen serves one model it never sizes.
  const diskGb = onDisk.reduce((n, x) => n + (x.sizeGb ?? 0), 0)

  return (
    <TableSection
      title="Models"
      // What the catalog holds, what is on disk, and what the gateway gets:
      // the readings the Offered panel drew, said once, over the table.
      note={
        m.models.length === 0 ? undefined : (
          <>
            {num(m.models.length)} in the catalog · {num(onDisk.length)} on disk
            {diskGb > 0 && ` (${num(diskGb, 1)} GB)`} ·{' '}
            <span className={m.offerableCount > 0 ? undefined : 'text-warning'}>
              {num(m.offerableCount)} offered to the gateway
            </span>{' '}
            · {num(routed)} routed now
          </>
        )
      }
      foot={
        <>
          {/* Not offered: the state and its fix, which a glance needs. */}
          {!m.offered && (
            <p className={CAPTION}>
              {m.machine === 'box'
                ? 'Speech to text, served by the box itself rather than by a node. Offer it on Settings › Machines to publish it through the gateway.'
                : 'Switch "offer to the gateway" on Settings › Machines to publish these.'}
            </p>
          )}
          {/* The build behind each runtime named on the models above — the
              build NUMBER moves far more often than a release does, and it is
              the thing that changes how fast a model runs. */}
          {backends.length > 0 && (
            <p className={BUILDS}>
              <span>Runtime builds</span>
              {backends.map((b) => (
                <span key={`${b.recipe}-${b.backend}`} className="inline-flex gap-1.5">
                  <span className="text-subdued">{b.recipe}</span>
                  {b.url === null ? (
                    <span className={MONO}>{b.version ?? DASH}</span>
                  ) : (
                    <a
                      className={cn(
                        MONO,
                        'text-muted-foreground no-underline hover:text-foreground',
                      )}
                      href={b.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {b.version ?? DASH}
                    </a>
                  )}
                </span>
              ))}
            </p>
          )}
          {m.offered && (
            <p className={FOOT}>
              The gateway sync writes a route per offered model and removes it when the model
              leaves. Which models are offered, and under what name, is Settings › Machines.
            </p>
          )}
          {/* Only where there is something for it to explain. */}
          {groups.length > 0 && (
            <p className={FOOT}>
              {m.manageable
                ? 'One model of each kind is resident at a time, so picking a different one means putting the current one down. Switch does both in order, because a pinned model is exempt from eviction and the incoming load is refused if the slot is not freed first. Figures survive an eviction, so a model you have not run today still shows what it managed last time — but not a restart of the provider, which is where they are counted. A figure that is still zero is left blank.'
                : 'This provider serves one model and holds it for its lifetime; there is no slot to change.'}
            </p>
          )}
        </>
      }
    >
      {/* Only while something is actually downloading, and above everything
          else: it is the one thing here that is mid-change and the one thing
          that looks wrong if left unexplained. */}
      {downloads.length > 0 && (
        <ul className={DOWNLOADS}>
          {downloads.map((d) => (
            <li key={d.model} className={DOWNLOAD}>
              <span>{d.model}</span>
              <span className={cn(MONO, 'ml-auto text-foreground')}>
                {d.status}
                {d.percent === null ? '' : ` · ${num(d.percent)}%`}
              </span>
            </li>
          ))}
        </ul>
      )}

      <ul className={TABLE} aria-label={`Models on ${m.name}`}>
        {groups.length > 0 && <ModelHead />}
        {groups.length === 0 ? (
          <li className={TABLE_EMPTY}>
            {m.reachable ? 'The provider lists no models.' : 'Unknown until it answers.'}
          </li>
        ) : (
          groups.map((g) => <ModelKind key={g.mode} group={g} m={m} />)
        )}
      </ul>
    </TableSection>
  )
}
