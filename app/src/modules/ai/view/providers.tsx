import { Link, useRouter, useSearch } from '@tanstack/react-router'
import { useState } from 'react'
import { LogBoard, type LogNeighbour } from '../../../components/logs'
import { HeadStrip, OS_MARK, WipBoard } from '../../../components/machine-system/shared'
import { FOOT, MONO, NOTE } from '../../../components/tokens'
import { Button } from '../../../components/ui/button'
import { Board, BoardGrid, Chip, Measures, Pulse } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { compact, DASH, num } from '../../../lib/format'
import { MODE_WORD } from '../../../lib/providers/policy'
import { loadProviderModelFn, unloadProviderModelFn } from '../../../server/providers'
import type { CatalogEntry, Chain, ProviderMachine, ProvidersData } from '../data/providers'

// The Providers tab: the chain once, then the picked machine in full.
//
// The picker is inside the tab rather than above the row — this is the one
// tab whose subject is several machines, and the other two are services on
// this box. Every machine's reading is in the payload, so a pick is a
// re-render; the URL carries it so a refresh and a link keep it.
//
// The models are grouped by KIND, because the constraint is per kind: one
// model of each may be resident, so a kind's models are competing answers
// to a single question rather than a flat list. That is also what makes the
// two buttons make sense — server/providers.ts says why a switch has to put
// the incumbent down first.

const BOX_MARK = { src: '/icon-nixos.webp', invert: false }

/* ── the chain ────────────────────────────────────────────────────────── */

function ChainBoard({ chain }: { chain: Chain }) {
  const cell = (title: string, big: string, lines: string[]) => (
    <div className="min-w-0 flex-1 rounded-md border border-(--border-soft) px-3 py-2">
      <p className={`${NOTE} m-0`}>{title}</p>
      <p className="m-0 text-[1.3rem] leading-[1.15] tracking-[-0.015em] tabular-nums [font-weight:550]">
        {big}
      </p>
      {lines.map((l) => (
        <p key={l} className={`${FOOT} m-0 mt-[0.1rem]`}>
          {l}
        </p>
      ))}
    </div>
  )
  const arrow = (
    <span aria-hidden className="flex-none self-center text-[1.1rem] text-(--dim)">
      →
    </span>
  )
  const g = chain.gateway
  return (
    <BoardGrid>
      <Board title="The chain" icon="grid" span={12}>
        <div className="flex items-stretch gap-[0.6rem] max-[44rem]:flex-col">
          {cell(
            'Providers',
            `${num(chain.providers.machines)} ${chain.providers.machines === 1 ? 'machine' : 'machines'}`,
            [
              `${num(chain.providers.reachable)} answering · ${num(chain.providers.offerable)} models offered`,
            ],
          )}
          {arrow}
          {cell(
            'Gateway',
            g.configured ? `${num(g.routes)} routes` : 'none',
            g.configured
              ? [
                  `${num(g.synced)} written by daedalus · ${num(g.fromConfig)} from config.yaml`,
                  ...(g.error === null ? [] : [g.error]),
                ]
              : ['no LiteLLM bound to this box'],
          )}
          {arrow}
          {cell(
            'Consumers',
            `${num(chain.consumers.length)} ${chain.consumers.length === 1 ? 'caller' : 'callers'}`,
            [chain.consumers.map((c) => c.name).join(', ') || 'nothing calls it yet'],
          )}
        </div>
        <p className={FOOT}>
          A caller speaks the OpenAI API to the gateway; the gateway forwards to whichever machine
          provides the model; that machine holds the weights. Routes written by daedalus come from
          the providers below and follow them; routes from config.yaml are the hand-kept ones.
        </p>
      </Board>
    </BoardGrid>
  )
}

/* ── the picker ───────────────────────────────────────────────────────── */

/* Its own band, with air above and below. It sat flush under the chain
   board, which read as a caption on it rather than as the control that
   decides everything below. The label earns its line for the same reason: a
   bare row of machine names does not say what picking one does. */
const PICKER = 'mt-[1.6rem] mb-[1.35rem] flex flex-wrap items-center gap-[0.5rem]'
const PICKER_LABEL = 'mr-[0.3rem] text-[0.6rem] tracking-[0.09em] text-(--dim) uppercase'

function MachinePills({ machines, active }: { machines: ProviderMachine[]; active: string }) {
  const pill = (selected: boolean) =>
    cn(
      'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[0.8rem] transition-colors',
      selected
        ? 'border-primary bg-primary/10 text-foreground'
        : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
    )
  return (
    <nav aria-label="Provider machine" className={PICKER}>
      <span className={PICKER_LABEL}>machines</span>
      {machines.map((m) => {
        const mark = m.machine === 'box' ? BOX_MARK : OS_MARK[m.os]
        // Only when one machine runs more than one model server does the
        // kind belong in its name; otherwise it is a word repeated down the
        // row that distinguishes nothing.
        const ambiguous = machines.filter((o) => o.machine === m.machine).length > 1
        return (
          <Link
            key={m.id}
            to="/c/$category"
            params={{ category: 'ai' }}
            search={{ tab: 'providers', machine: m.id }}
            className={pill(active === m.id)}
          >
            {mark !== undefined && (
              <img
                src={mark.src}
                alt=""
                width={14}
                height={14}
                className={cn('size-3.5', mark.invert && 'dark:invert')}
              />
            )}
            {m.name}
            {ambiguous && <span className="text-muted-foreground">· {m.kindName}</span>}
            <Pulse on={m.reachable} tone={m.reachable ? 'ok' : 'muted'} />
          </Link>
        )
      })}
    </nav>
  )
}

/* ── the model widget ─────────────────────────────────────────────────── */

/* Styled as a sibling of the changelog's release rows: both are "a stack of
   things you open", and looking alike is the point. */
const KIND =
  'border-b border-(--border-soft) last-of-type:border-b-0 [&[open]>summary]:before:rotate-90'
const KIND_SUMMARY =
  "flex min-w-0 cursor-pointer list-none items-baseline gap-[0.55rem] px-[0.15rem] py-[0.5rem] hover:bg-(--raise) [&::-webkit-details-marker]:hidden before:text-[0.7rem] before:text-(--dim) before:transition-transform before:duration-[0.12s] before:ease-[ease] before:content-['▸']"
const KIND_TYPE = 'text-[0.68rem] font-semibold tracking-[0.11em] text-primary uppercase'
const KIND_FREE =
  'rounded-full border border-warning/40 px-[0.35rem] py-[0.02rem] text-[0.62rem] text-warning'
/* The aggregate for the whole kind, so a collapsed row still says
   something. Interpuncts generated rather than typed, so a missing figure
   does not leave a dangling separator. */
const KIND_AGG =
  "ml-auto flex gap-[0.45rem] whitespace-nowrap text-[0.7rem] text-(--dim) tabular-nums [&>span+span]:before:mr-[0.45rem] [&>span+span]:before:text-border [&>span+span]:before:content-['·']"
const KIND_BODY = 'pt-[0.1rem] pb-[0.7rem]'
const KIND_EMPTY = 'm-0 text-[0.78rem] text-warning'

/* Only present mid-download, so it is allowed to be loud. */
const DOWNLOADS = 'm-0 mb-[0.6rem] flex list-none flex-col gap-[0.2rem] p-0'
const DOWNLOAD =
  'flex gap-[0.6rem] rounded-[6px] bg-[color-mix(in_srgb,var(--primary)_10%,var(--panel-2))] px-[0.45rem] py-[0.2rem] text-[0.74rem] text-(--text-muted)'

/* The model in the slot. Given real weight — it is the answer to the kind's
   question, and everything below it is an alternative. */
const HERO = 'group/hero rounded-[9px] bg-(--panel-2) px-[0.6rem] py-[0.5rem]'
const HERO_NAME = 'min-w-0 truncate text-[0.85rem] font-semibold text-foreground'

/* The other models of this kind — one click from the slot. */
const ALTS = 'm-0 mt-[0.3rem] flex list-none flex-col gap-[0.15rem] p-0'
const ALT =
  'group/alt flex min-w-0 items-center gap-[0.6rem] rounded-[7px] px-[0.6rem] py-[0.22rem] hover:bg-(--panel-2) max-[46rem]:flex-wrap'
const ALT_NAME = 'min-w-0 truncate text-[0.8rem] text-(--text-muted)'
const ALT_META =
  'ml-auto flex items-baseline gap-x-[0.9rem] gap-y-0 whitespace-nowrap text-[0.7rem] text-(--dim) tabular-nums max-[46rem]:ml-0'

/* The row's button: quiet until wanted. The row is information first and an
   action second, and a column of always-lit buttons would compete with the
   model that is actually running. */
const QUIET_BTN =
  'h-auto flex-none px-[0.5rem] py-[0.15rem] text-[0.68rem] text-(--text-muted) opacity-45 transition-opacity duration-[0.12s] focus-visible:opacity-100'

/* Build numbers for the runtimes named on the models above. One line: that
   is all they are worth once the runtime itself is stated per model. */
const BUILDS =
  'mx-0 mt-[1.1rem] mb-0 flex flex-wrap gap-x-[1.1rem] gap-y-[0.2rem] border-t border-(--border-soft) pt-[0.7rem] text-[0.68rem] text-(--dim)'

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

/** What the gateway calls this model, if it carries it at all. */
function GatewayName({ model }: { model: CatalogEntry }) {
  if (model.routed !== null) {
    return <span className={`${MONO} text-(--tone-ok)`}>routed as {model.routed}</span>
  }
  if (!model.downloaded) return <span>not on disk</span>
  if (model.offerable) return <span className={MONO}>{model.alias} · awaiting the sync</span>
  return <span>not offered</span>
}

/** The model in the slot: what it is, and what it has done. */
function ModelHero({ model, m }: { model: CatalogEntry; m: ProviderMachine }) {
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
        <span className="ml-[0.2rem] text-[0.7rem] text-(--dim)">
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
function ModelAlt({
  model,
  m,
  replacing,
}: {
  model: CatalogEntry
  m: ProviderMachine
  replacing: CatalogEntry | null
}) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
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
        <span className="text-[0.7rem] text-(--tone-bad)" title={error}>
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
            setBusy(true)
            setError(null)
            void loadProviderModelFn({
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
            })
              .then((r) => {
                if (!r.ok) setError(r.reason)
                return router.invalidate()
              })
              .finally(() => {
                setBusy(false)
              })
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
  const router = useRouter()
  const [busy, setBusy] = useState(false)
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
        setBusy(true)
        void unloadProviderModelFn({ data: { machine: m.machine, kind: m.kind, model: model.id } })
          .then(() => router.invalidate())
          .finally(() => {
            setBusy(false)
          })
      }}
    >
      {busy ? 'Evicting…' : 'Evict'}
    </Button>
  )
}

/* ── one machine ──────────────────────────────────────────────────────── */

/** Where a kind documents itself. Nothing here is about a particular machine. */
const KIND_LINKS: Partial<Record<ProviderMachine['kind'], { label: string; href: string }[]>> = {
  lemonade: [
    { label: 'API docs', href: 'https://lemonade-server.ai/docs/api/lemonade/' },
    { label: 'Model library', href: 'https://lemonade-server.ai/docs/server/server_models/' },
    { label: 'GitHub', href: 'https://github.com/lemonade-sdk/lemonade' },
  ],
}

/* Under the head, hanging past the artwork so it lines up with the name. */
const ACTIONS =
  'mt-[0.35rem] mr-0 mb-[1.1rem] ml-[3.4rem] flex flex-wrap items-center gap-x-4 gap-y-[0.5rem] max-[44rem]:ml-0'
const DOC_LINK = 'text-[0.74rem] text-muted-foreground no-underline hover:text-primary'

/**
 * The provider's own window, and where its kind is documented.
 *
 * The open button is only drawn for a provider a browser could actually
 * reach: this box's own is at the host-gateway alias, which means nothing
 * outside a container. Everything the page does to a model it does through
 * a server function (server/providers.ts says why), so this link is for the
 * things the page deliberately does not do — registering a checkpoint,
 * installing a backend, deleting weights.
 */
function ProviderActions({ m }: { m: ProviderMachine }) {
  const docs = KIND_LINKS[m.kind] ?? []
  // Only what a browser could actually open: this box's own provider is at
  // the host-gateway alias, which means nothing outside a container, and a
  // provider that is not answering has no window to open.
  const openable = m.machine !== 'box' && m.reachable
  if (!openable && docs.length === 0) return null
  return (
    <p className={ACTIONS}>
      {openable && (
        <Button asChild size="sm" variant="outline">
          <a href={m.base} target="_blank" rel="noreferrer">
            Open {m.kindName} ↗
          </a>
        </Button>
      )}
      {docs.map((l) => (
        <a key={l.href} className={DOC_LINK} href={l.href} target="_blank" rel="noreferrer">
          {l.label} ↗
        </a>
      ))}
    </p>
  )
}

/**
 * The bridge is diagnostics for the model server's panel, not a service
 * anybody watches — so it gets the same treatment as every other
 * neighbour.
 */
const LOG_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { container: 'lemonade-logs' },
    label: 'Bridge logs',
    role: 'the process shipping the above',
    title: 'Log bridge',
    note: 'Deliberately a separate stream: this is the bridge’s own reconnects and gap warnings, and mixing them into the model server’s log would make it look like it was reporting network trouble it knows nothing about. Look here when the panel above goes quiet.',
  },
]

function MachineView({ m, logs }: { m: ProviderMachine; logs: ProvidersData['logs'] }) {
  // A machine nothing offers and no agent has seen is not a fault: it is a
  // provider not installed yet, and the line says what installing it does.
  const absent = !m.reachable && !m.offered && m.presence === null && m.machine !== 'box'
  const chip = m.reachable
    ? { label: 'answering', tone: 'ok' as const }
    : absent
      ? { label: 'not installed', tone: 'muted' as const }
      : { label: 'not answering', tone: 'bad' as const }
  const presence =
    m.presence === null
      ? m.machine === 'box'
        ? 'a service of the tv stack'
        : 'the agent has not reported it'
      : m.presence.running
        ? `the agent sees it running${m.presence.version === null ? '' : ` · v${m.presence.version}`}`
        : 'the agent sees it installed but not running'
  const groups = groupsOf(m.models)
  const onDisk = m.models.filter((x) => x.downloaded)
  const routed = m.models.filter((x) => x.routed !== null).length
  const { downloads, backends } = m.detail
  // A provider that reports no size for anything is not a provider holding
  // nought gigabytes — subgen serves one model it never sizes.
  const diskGb = onDisk.reduce((n, x) => n + (x.sizeGb ?? 0), 0)

  return (
    <>
      <HeadStrip
        mark={m.machine === 'box' ? BOX_MARK : OS_MARK[m.os]}
        name={m.name}
        chip={chip}
        aside={`${m.kindName}${m.version === null ? '' : ` ${m.version}`}`}
        line={
          <>
            <span className={MONO}>{m.base}</span> · {presence} ·{' '}
            {m.offered ? 'offered to the gateway' : 'not offered to the gateway'}
            {m.error !== null && !absent && ` · ${m.error}`}
            {absent &&
              ` · install ${m.kindName}${m.os === 'macos' ? ' for macOS (Metal)' : ''} on it and offer it on Settings › Machines`}
          </>
        }
      />
      <ProviderActions m={m} />

      <BoardGrid>
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
                    <span className={cn(MONO, 'text-(--text-muted)')}>{b.version ?? DASH}</span>
                  ) : (
                    <a
                      className={cn(MONO, 'text-(--text-muted) no-underline hover:text-primary')}
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

        <Board title="Offered" icon="grid" span={4}>
          <Measures
            items={[
              { k: 'in the catalog', v: num(m.models.length) },
              { k: 'on disk', v: num(onDisk.length) },
              {
                k: 'offered to the gateway',
                v: num(m.offerableCount),
                tone: m.offerableCount > 0 ? 'ok' : 'muted',
              },
              { k: 'routed now', v: num(routed) },
            ]}
          />
          <p className={FOOT}>
            {m.offered
              ? 'The gateway sync writes a route per offered model and removes it when the model leaves. Which models are offered, and under what name, is Settings › Machines.'
              : m.machine === 'box'
                ? 'Speech to text, served by the box itself rather than by a node. Offer it on Settings › Machines to publish it through the gateway.'
                : 'Switch "offer to the gateway" on Settings › Machines to publish these.'}
          </p>
        </Board>

        {/* Only for a machine that has an agent to wait on. This box has
            none, and its provider runs on the CPU. */}
        {m.machine !== 'box' && (
          <WipBoard title="GPU right now" span={12} waits="waits on the agent’s GPU live figures">
            <Measures
              items={[
                { k: 'load', v: '41%' },
                { k: 'memory', v: '13.2 of 24 GB' },
                { k: 'die', v: '61 °C' },
                { k: 'clock', v: '2,410 MHz' },
              ]}
            />
          </WipBoard>
        )}

        {/* One bridge, one target: the panel belongs to the machine whose
            log this box actually ships. Drawn under every provider of the
            kind, it told a second machine its logs were being collected. */}
        {logs?.machine === m.machine && (
          <LogBoard
            source={{ stack: logs.stack }}
            title={`${m.kindName} logs`}
            foot={
              <p className={FOOT}>
                The model server’s own log, streamed off the machine over its{' '}
                <code>/logs/stream</code> WebSocket and pushed to Loki by the bridge below.
                Timestamps are the ones the server recorded, not the ones Loki received.
              </p>
            }
            neighbours={LOG_NEIGHBOURS}
          />
        )}
      </BoardGrid>
    </>
  )
}

/* ── the tab ──────────────────────────────────────────────────────────── */

export function ProvidersView({ data }: { data: ProvidersData }) {
  const search = useSearch({ from: '/c/$category' })
  const wanted = search.machine ?? data.defaultMachine
  const active =
    data.machines.find((m) => m.id === wanted || m.machine === wanted) ?? data.machines[0]

  return (
    <>
      <ChainBoard chain={data.chain} />
      {data.machines.length === 0 ? (
        <p className={FOOT}>
          No machine provides models yet. Approve one on Settings › Machines and offer its provider,
          or switch the tv stack on for this box's own.
        </p>
      ) : (
        <>
          {/* The pill the URL selected, by id — it was compared against the
              machine, which is only half of a row's identity, so nothing
              ever looked picked. */}
          <MachinePills machines={data.machines} active={active?.id ?? ''} />
          {active !== undefined && <MachineView m={active} logs={data.logs} />}
        </>
      )}
    </>
  )
}
