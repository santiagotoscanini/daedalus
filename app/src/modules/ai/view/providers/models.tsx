// The model widget: one machine's catalog grouped by kind.

import { FOOT, MONO, NOTE } from '../../../../components/tokens'
import { Board } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { compact, DASH, num } from '../../../../lib/format'
import { MODE_WORD } from '../../../../lib/providers/policy'
import type { CatalogEntry, ProviderMachine } from '../../data/providers'
import { ModelAlt, ModelHero } from './model-row'

/* ── the model widget ─────────────────────────────────────────────────── */

/* Styled as a sibling of the changelog's release rows: both are "a stack of
   things you open", and looking alike is the point. */
const KIND = 'border-b border-subtle last-of-type:border-b-0 [&[open]>summary]:before:rotate-90'
const KIND_SUMMARY =
  "flex min-w-0 cursor-pointer list-none items-baseline gap-[0.55rem] px-[0.15rem] py-[0.5rem] hover:bg-lifted [&::-webkit-details-marker]:hidden before:text-[0.7rem] before:text-muted-foreground before:transition-transform before:duration-[0.12s] before:ease-[ease] before:content-['▸']"
const KIND_TYPE = 'text-[0.68rem] font-semibold tracking-[0.11em] text-primary uppercase'
const KIND_FREE =
  'rounded-full border border-warning/40 px-[0.35rem] py-[0.02rem] text-[0.62rem] text-warning'
/* The aggregate for the whole kind, so a collapsed row still says
   something. Interpuncts generated rather than typed, so a missing figure
   does not leave a dangling separator. */
const KIND_AGG =
  "ml-auto flex gap-[0.45rem] whitespace-nowrap text-[0.7rem] text-muted-foreground tabular-nums [&>span+span]:before:mr-[0.45rem] [&>span+span]:before:text-border [&>span+span]:before:content-['·']"
const KIND_BODY = 'pt-[0.1rem] pb-[0.7rem]'
const KIND_EMPTY = 'm-0 text-[0.78rem] text-warning'

/* The other models of this kind — one click from the slot. */
const ALTS = 'm-0 mt-[0.3rem] flex list-none flex-col gap-[0.15rem] p-0'

/* Only present mid-download, so it is allowed to be loud. */
const DOWNLOADS = 'm-0 mb-[0.6rem] flex list-none flex-col gap-[0.2rem] p-0'
const DOWNLOAD =
  'flex gap-[0.6rem] rounded-[6px] bg-[color-mix(in_srgb,var(--primary)_10%,var(--panel-2))] px-[0.45rem] py-[0.2rem] text-[0.74rem] text-subdued'

/* Build numbers for the runtimes named on the models above. One line: that
   is all they are worth once the runtime itself is stated per model. */
const BUILDS =
  'mx-0 mt-[1.1rem] mb-0 flex flex-wrap gap-x-[1.1rem] gap-y-[0.2rem] border-t border-subtle pt-[0.7rem] text-[0.68rem] text-muted-foreground'

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

/**
 * Every model of one kind, folded away until asked for.
 *
 * Open when something of this kind is resident, because that is the group
 * whose state is live and the one a glance came for. A closed summary still
 * has to earn its line — a row you must open to learn anything from is
 * worse than no row — so it carries the aggregate: how many models, how
 * much disk, and what they have managed between them.
 *
 * `details` rather than a state hook: it works before hydration, survives
 * it, and the browser already knows how.
 */
function ModelKind({ group, m }: { group: Group; m: ProviderMachine }) {
  const resident = group.models.find((x) => x.loaded !== null) ?? null
  const others = group.models.filter((x) => x !== resident)
  const sum = (pick: (x: CatalogEntry) => number | null | undefined) =>
    group.models.reduce((n, x) => n + (pick(x) ?? 0), 0)
  const size = sum((x) => x.sizeGb)
  const requests = sum((x) => x.figures?.requests)
  const tokens = sum((x) => (x.figures?.inputTokens ?? 0) + (x.figures?.outputTokens ?? 0))
  // An empty slot is only worth calling out where a slot is a thing: a
  // provider the box cannot load into has no empty slot, just nothing
  // resident.
  const slotFree = m.manageable && resident === null

  return (
    <details className={KIND} open={resident !== null}>
      <summary className={KIND_SUMMARY}>
        <span className={KIND_TYPE}>{MODE_WORD[group.mode]}</span>
        {slotFree && <span className={KIND_FREE}>slot free</span>}
        {/* Abbreviated: these are a sense of scale rather than quantities —
            976k answers "has anything been using these", and 976,228
            answers it no better while costing half the row. */}
        <span className={KIND_AGG}>
          <span>
            {group.models.length === 1 ? '1 model' : `${String(group.models.length)} models`}
          </span>
          {size > 0 && <span>{num(size, 1)} GB</span>}
          {requests > 0 && <span>{compact(requests)} req</span>}
          {tokens > 0 && <span>{compact(tokens)} tok</span>}
        </span>
      </summary>

      <div className={KIND_BODY}>
        {resident === null ? (
          <p className={KIND_EMPTY}>
            {m.manageable
              ? 'nothing loaded. The next request cold-loads one'
              : 'nothing resident right now'}
          </p>
        ) : (
          <ModelHero model={resident} m={m} />
        )}
        {others.length > 0 && (
          <ul className={ALTS}>
            {others.map((x) => (
              <ModelAlt key={x.id} model={x} m={m} replacing={resident} />
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}

/** The machine's catalog by kind, with anything mid-download above it and the runtime builds under it. */
export function ModelsBoard({ m }: { m: ProviderMachine }) {
  const groups = groupsOf(m.models)
  const { downloads, backends } = m.detail
  // A provider that reports no size for anything is not a provider holding
  // nought gigabytes — subgen serves one model it never sizes.
  const diskGb = m.models.filter((x) => x.downloaded).reduce((n, x) => n + (x.sizeGb ?? 0), 0)
  return (
    <Board
      title="Models"
      icon="rows"
      span={8}
      aside={
        m.models.length === 0 ? undefined : (
          <span className={NOTE}>
            {num(m.models.length)}
            {diskGb > 0 && ` · ${num(diskGb, 1)} GB on disk`}
          </span>
        )
      }
    >
      {/* Only while something is actually downloading, and above
          everything else: it is the one thing here that is mid-change
          and the one thing that looks wrong if left unexplained. */}
      {downloads.length > 0 && (
        <ul className={DOWNLOADS}>
          {downloads.map((d) => (
            <li key={d.model} className={DOWNLOAD}>
              <span>{d.model}</span>
              <span className={cn(MONO, 'ml-auto text-primary')}>
                {d.status}
                {d.percent === null ? '' : ` · ${num(d.percent)}%`}
              </span>
            </li>
          ))}
        </ul>
      )}

      {groups.length === 0 ? (
        <p className={FOOT}>
          {m.reachable ? 'The provider lists no models.' : 'Unknown until it answers.'}
        </p>
      ) : (
        groups.map((g) => <ModelKind key={g.mode} group={g} m={m} />)
      )}

      {/* The build behind each runtime named on the models above. Folded
          in here rather than given a panel, which restated every runtime
          name a second time: what is worth knowing separately is the
          build NUMBER, and it moves far more often than a release does
          — it is the thing that changes how fast a model runs. */}
      {backends.length > 0 && (
        <p className={BUILDS}>
          {backends.map((b) => (
            <span key={`${b.recipe}-${b.backend}`} className="inline-flex gap-[0.35rem]">
              {b.recipe}
              {b.url === null ? (
                <span className={cn(MONO, 'text-subdued')}>{b.version ?? DASH}</span>
              ) : (
                <a
                  className={cn(MONO, 'text-subdued no-underline hover:text-primary')}
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

      {/* Only where there is something for it to explain: under an
          empty catalog it is a paragraph about buttons that are not
          there. */}
      {groups.length > 0 && (
        <p className={FOOT}>
          {m.manageable
            ? 'One model of each kind is resident at a time, so picking a different one means putting the current one down. Switch does both in order, because a pinned model is exempt from eviction and the incoming load is refused if the slot is not freed first. Figures survive an eviction, so a model you have not run today still shows what it managed last time — but not a restart of the provider, which is where they are counted.'
            : 'This provider serves one model and holds it for its lifetime; there is no slot to change.'}
        </p>
      )}
    </Board>
  )
}
