import { useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { cn } from '../../../lib/cn'
import type { AiData } from '../../../lib/dashboard/categories/ai'
import { compact, DASH, num, pct } from '../../../lib/format'
import { switchLemonadeModel, unloadLemonadeModel } from '../../../server/lemonade'
import { InfoHint } from '../../hint'
import { LogBoard, type LogNeighbour } from '../../logs'
import { Changelog } from '../../release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../service-head'
import { Button } from '../../ui/button'
import { Board, BoardGrid, Chip, Measures, Pulse } from '../../viz'
import { comparePinned, EMPTY, FOOT, MONO, NOTE } from './shared'

// ── Lemonade ───────────────────────────────────────────────────────────────

export function LemonadeView({ data }: { data: Extract<AiData, { tab: 'lemonade' }> }) {
  const { gap, host, live, categories } = data
  const installed = categories.reduce((n, c) => n + c.models.length, 0)

  return (
    <>
      <ServiceHead
        logo="/icon-lemonade.png"
        name="Lemonade"
        version={data.version}
        versionNote="running on the gaming PC"
        verdict={verdictOf(gap)}
        compare={comparePinned(gap, 'nothing. It is installed on Windows, not in the flake')}
        lede={
          <>
            The only thing in this stack that holds weights, and the only one not on this box.
            Callers reach it through LiteLLM, never directly.
          </>
        }
        actions={
          <Button asChild size="sm">
            <a href={data.baseUrl} target="_blank" rel="noreferrer">
              Open Lemonade ↗
            </a>
          </Button>
        }
      />
      {/* The machine, as a strip rather than a panel. It was eight facts in a
          board of their own, most of them constants — a CPU model does not
          change — competing for width with the two things on this page that do
          change. Here each is a phrase you can read past, with the detail
          behind a hover for the once a year you need the driver version. */}
      <HostStrip host={host} live={live} />

      <LinkRow
        links={[
          { label: 'API docs', href: 'https://lemonade-server.ai/docs/api/lemonade/' },
          { label: 'Model library', href: 'https://lemonade-server.ai/docs/server/server_models/' },
          { label: 'GitHub', href: 'https://github.com/lemonade-sdk/lemonade' },
        ]}
      />

      {/* No headline band. Every number that was in it — throughput, first
          token, requests, how many are resident — is a property of a
          particular model, and the band could only ever show it for whichever
          one happened to run last. Stating it per model below says strictly
          more, in less space, without the same figure appearing twice. */}
      <BoardGrid>
        <Board
          title="Models"
          icon="rows"
          span={6}
          aside={
            <span className={NOTE}>
              {installed} · {num(data.catalog.sizeGb, 1)} GB
            </span>
          }
        >
          {/* Only while something is actually downloading, and above the fold
              of everything else: it is the one thing here that is mid-change
              and the one thing that will look wrong if unexplained. */}
          {data.downloads.length > 0 && (
            <ul className={DOWNLOADS}>
              {data.downloads.map((d) => (
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

          {categories.length === 0 ? (
            <p className={EMPTY}>Lemonade did not answer</p>
          ) : (
            categories.map((c) => <ModelKind key={c.type} kind={c} />)
          )}

          {/* The build behind each runtime named above. Folded in here rather
              than given a panel of its own, which restated every runtime name
              a second time: what is worth knowing separately is only the build
              NUMBER, and it moves far more often than a Lemonade release does
              — it is the thing that changes how fast a model runs. */}
          {data.backends.length > 0 && (
            <p className={BUILDS}>
              {data.backends.map((b) => (
                <span key={`${b.recipe}-${b.backend}`} className="inline-flex gap-[0.35rem]">
                  {b.recipe}
                  {b.url === null ? (
                    <span className={cn(MONO, 'text-(--text-muted)')}>{b.version}</span>
                  ) : (
                    <a
                      className={cn(MONO, 'text-(--text-muted) no-underline hover:text-primary')}
                      href={b.url}
                      target="_blank"
                      rel="noreferrer"
                    >
                      {b.version}
                    </a>
                  )}
                </span>
              ))}
            </p>
          )}

          <p className={FOOT}>
            Lemonade keeps one model of each kind in VRAM, so picking a different chat model means
            putting down the current one. <b>Switch</b> does both in order, because a pinned model
            is exempt from eviction and the incoming load is refused if the slot is not freed first.
            Counts survive an eviction, so a model you have not run today still shows what it
            managed last time.
          </p>
        </Board>

        <Changelog gap={gap} span={6} />

        {/* Selected by STACK, not container. These lines were not produced on
            this box at all — the bridge in stacks/lemonade-logs reads
            Lemonade's WebSocket on the gaming PC and pushes them to Loki
            directly, so there is no podman container to name. */}
        <LogBoard
          source={{ stack: 'lemonade' }}
          title="Lemonade server logs"
          foot={
            <p className={FOOT}>
              Lemonade’s own log, streamed off the gaming PC over its <code>/logs/stream</code>{' '}
              WebSocket and pushed to Loki by the bridge below. Timestamps are the ones Lemonade
              recorded, not the ones Loki received.
            </p>
          }
          neighbours={LEMONADE_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}

/* ── the model widget ─────────────────────────────────────────────────── */

/* Grouped by KIND, because the constraint is per kind: one model of each type
   may be resident, so a category's installed models are competing answers to a
   single question rather than a list. Styled as a sibling of the changelog's
   release rows on purpose — the two half-width panels are both "a stack of
   things you open", and looking alike is the point. */
const KIND =
  'border-b border-(--border-soft) last-of-type:border-b-0 [&[open]>summary]:before:rotate-90'
const KIND_SUMMARY =
  "flex min-w-0 cursor-pointer list-none items-baseline gap-[0.55rem] px-[0.15rem] py-[0.5rem] hover:bg-(--raise) [&::-webkit-details-marker]:hidden before:text-[0.7rem] before:text-(--dim) before:transition-transform before:duration-[0.12s] before:ease-[ease] before:content-['▸']"
const KIND_TYPE = 'text-[0.68rem] font-semibold tracking-[0.11em] text-primary uppercase'
const KIND_FREE =
  'rounded-full border border-warning/40 px-[0.35rem] py-[0.02rem] text-[0.62rem] text-warning'
/* The aggregate for the whole kind, so a collapsed row still says something.
   Interpuncts between, generated rather than typed, so a missing figure does
   not leave a dangling separator. */
const KIND_AGG =
  "ml-auto flex gap-[0.45rem] whitespace-nowrap text-[0.7rem] text-(--dim) tabular-nums [&>span+span]:before:mr-[0.45rem] [&>span+span]:before:text-border [&>span+span]:before:content-['·']"
const KIND_BODY = 'pt-[0.1rem] pb-[0.7rem]'
const KIND_EMPTY = 'm-0 text-[0.78rem] text-warning'

/* Only present mid-download, so it is allowed to be loud. */
const DOWNLOADS = 'm-0 mb-[0.6rem] flex list-none flex-col gap-[0.2rem] p-0'
const DOWNLOAD =
  'flex gap-[0.6rem] rounded-[6px] bg-[color-mix(in_srgb,var(--primary)_10%,var(--panel-2))] px-[0.45rem] py-[0.2rem] text-[0.74rem] text-(--text-muted)'

/* The model in the slot. Given real weight — it is the answer to the
   category's question, and everything below it is an alternative. Two literal
   fills rather than an override, so the hot one cannot lose to the resting
   one through class merging. */
const HERO = 'group/hero rounded-[9px] px-[0.6rem] py-[0.5rem]'
const HERO_FILL = 'bg-(--panel-2)'
const HERO_FILL_HOT = 'bg-[color-mix(in_srgb,var(--primary)_8%,var(--panel-2))]'
const HERO_NAME = 'min-w-0 truncate text-[0.85rem] font-semibold text-foreground'

/* The other models of this kind — one click from the slot. Below 46rem the
   row wraps and the figures start a fresh line. */
const ALTS = 'm-0 mt-[0.3rem] flex list-none flex-col gap-[0.15rem] p-0'
const ALT =
  'group/alt flex min-w-0 items-center gap-[0.6rem] rounded-[7px] px-[0.6rem] py-[0.22rem] hover:bg-(--panel-2) max-[46rem]:flex-wrap'
const ALT_NAME = 'min-w-0 truncate text-[0.8rem] text-(--text-muted)'
const ALT_META =
  'ml-auto flex gap-x-[0.9rem] gap-y-0 whitespace-nowrap text-[0.7rem] text-(--dim) tabular-nums max-[46rem]:ml-0'

/* The row's button. `Button variant="outline"` shrunk to the row and quiet
   until wanted: the row is information first and an action second, and six
   always-lit buttons would compete with the model that is running. The caller
   adds the group-hover that lights it, since which row it belongs to differs. */
const QUIET_BTN =
  'h-auto flex-none px-[0.5rem] py-[0.15rem] text-[0.68rem] text-(--text-muted) opacity-45 transition-opacity duration-[0.12s] focus-visible:opacity-100'

/* Build numbers for the runtimes named on the models above. One line, because
   that is all they are worth once the runtime itself is stated per model. */
const BUILDS =
  'mx-0 mt-[1.1rem] mb-0 flex flex-wrap gap-x-[1.1rem] gap-y-[0.2rem] border-t border-(--border-soft) pt-[0.7rem] text-[0.68rem] text-(--dim)'

/* The machine a service runs on, as a line of phrases under the description.
   Indented past the logo so it hangs under the header's text column. */
const HOST_STRIP =
  'mt-[0.5rem] mr-0 mb-0 ml-[3.4rem] flex flex-wrap gap-x-[0.9rem] gap-y-[0.15rem] text-[0.73rem] text-(--text-muted) max-[44rem]:ml-0'
const HOST_FACT =
  'rounded-[4px] border-b border-dotted border-(--border) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-(--brand)'

/**
 * Every model of one kind, folded away until asked for.
 *
 * The kind is the organising idea rather than a label, because the constraint
 * is per kind: exactly one chat model can be resident, so the four installed
 * ones are four answers to a single question rather than four list entries.
 *
 * Collapsed by default, and the summary has to earn that — a row you must open
 * to learn anything from is worse than no row. So it carries the aggregate for
 * the whole kind: how many models, how much disk, and what they have actually
 * done between them. That is the reading most glances want ("has anything been
 * using the image models?"), and opening one is for when the answer is yes.
 *
 * `details` rather than a state hook: it works before hydration, survives it,
 * and the browser already knows how.
 */
function ModelKind({ kind }: { kind: Extract<AiData, { tab: 'lemonade' }>['categories'][number] }) {
  const resident = kind.models.find((m) => m.resident) ?? null
  const others = kind.models.filter((m) => !m.resident)

  const sum = (pick: (m: Model) => number | null | undefined) =>
    kind.models.reduce((n, m) => n + (pick(m) ?? 0), 0)

  const size = sum((m) => m.sizeGb)
  const requests = sum((m) => m.stats?.requests)
  const tokens = sum((m) => (m.stats?.inputTokens ?? 0) + (m.stats?.outputTokens ?? 0))

  return (
    <details className={KIND}>
      <summary className={KIND_SUMMARY}>
        <span className={KIND_TYPE}>{kind.type}</span>
        {/* The one thing that is a fault rather than a statistic, so it is the
            one thing that gets a colour in a collapsed row. */}
        {resident === null && <span className={KIND_FREE}>slot free</span>}
        {/* Abbreviated, because these are a sense of scale rather than
            quantities — 976k answers "has anything been using these", and
            976,228 answers it no better while costing half the row. */}
        <span className={KIND_AGG}>
          <span>
            {kind.models.length === 1 ? '1 model' : `${String(kind.models.length)} models`}
          </span>
          {size > 0 && <span>{num(size, 1)} GB</span>}
          {requests > 0 && <span>{compact(requests)} req</span>}
          {tokens > 0 && <span>{compact(tokens)} tok</span>}
        </span>
      </summary>

      <div className={KIND_BODY}>
        {resident === null ? (
          <p className={KIND_EMPTY}>nothing loaded. The next request will cold-load one</p>
        ) : (
          <ModelHero model={resident} />
        )}

        {others.length > 0 && (
          <ul className={ALTS}>
            {others.map((m) => (
              <ModelAlt key={m.name} model={m} replacing={resident} />
            ))}
          </ul>
        )}
      </div>
    </details>
  )
}

type Lemonade = Extract<AiData, { tab: 'lemonade' }>
type Model = Lemonade['categories'][number]['models'][number]

/**
 * The machine Lemonade runs on, as a line of phrases under the description.
 *
 * This was a board of eight facts, and most of them are constants — the CPU
 * model, the amount of RAM and the OS build do not change between page loads,
 * so giving them a panel meant a third of the page never said anything new.
 * What a glance wants is "yes, it is the 7900 XTX box, and it is not busy";
 * what you occasionally want is the driver version, and that can be one hover
 * away rather than permanently on screen.
 *
 * Short label visible, full string on hover. Same CSS-only mechanism as the
 * version-compare card, for the same reason: this page streams, so anything
 * needing hydration would be inert for the first moment.
 */
function HostStrip({ host, live }: { host: Lemonade['host']; live: Lemonade['live'] }) {
  return (
    <p className={HOST_STRIP}>
      <HostFact
        short={shortGpu(host.gpu)}
        detail={host.gpu ?? 'GPU not reported'}
        note={host.driver === null ? undefined : `driver ${host.driver}`}
      />
      <HostFact
        short={shortCpu(host.cpu)}
        detail={host.cpu ?? 'CPU not reported'}
        note={live.cpuPct === null ? undefined : `${pct(live.cpuPct, 1)} in use now`}
      />
      <HostFact
        short={
          live.memGb === null || host.ramGb === null
            ? host.ramGb === null
              ? DASH
              : `${num(host.ramGb)} GB`
            : `${num(live.memGb, 1)} / ${num(host.ramGb)} GB`
        }
        detail="System memory in use on the gaming PC"
        note="not VRAM — see below"
      />
      {/* Named rather than omitted. Two facts that are absent for a reason are
          worth one muted phrase; silently showing five readings where there
          should be seven invites the assumption that the card is idle. */}
      <HostFact
        short="GPU load —"
        detail="Lemonade does not report GPU utilisation or VRAM on Windows"
        note="its Windows metrics backend returns “not implemented”, where its macOS and Linux ones do not. The gap is in the port, not the card"
        muted
      />
      <HostFact short={shortOs(host.os)} detail={host.os ?? 'OS not reported'} />
    </p>
  )
}

function HostFact({
  short,
  detail,
  note,
  muted,
}: {
  short: string
  detail: string
  note?: string
  muted?: boolean
}) {
  return (
    <InfoHint
      className={cn(HOST_FACT, muted === true && 'text-(--dim)')}
      cardClassName="top-[calc(100%+0.4rem)] left-0 flex w-max max-w-[20rem] flex-col gap-[0.25rem]"
      trigger={short}
    >
      <span className="text-[0.78rem] text-foreground">{detail}</span>
      {note !== undefined && (
        <span className="text-[0.7rem] leading-[1.4] text-(--text-muted)">{note}</span>
      )}
    </InfoHint>
  )
}

/** `AMD Radeon RX 7900 XTX` → `RX 7900 XTX`. The vendor prefix is noise. */
function shortGpu(s: string | null): string {
  if (s === null) return DASH
  return s.replace(/^AMD\s+Radeon(\(TM\))?\s+/i, '').replace(/\s+Graphics$/i, '')
}

/** `AMD Ryzen 7 7800X3D 8-Core Processor (8 cores, …)` → `Ryzen 7 7800X3D`. */
function shortCpu(s: string | null): string {
  if (s === null) return DASH
  return s
    .replace(/^AMD\s+|^Intel\(R\)\s+/i, '')
    .replace(/\s+\d+-Core Processor.*$/i, '')
    .replace(/\s*\(.*$/, '')
    .trim()
}

/** `Windows 11 Pro 6.3 (Build 26200)` → `Windows 11 Pro`. */
function shortOs(s: string | null): string {
  if (s === null) return DASH
  return s.replace(/\s+\d[\d.]*\s*\(Build.*$/i, '').trim()
}

/** The model in the slot: what it is, and what it has done. */
function ModelHero({ model }: { model: Model }) {
  const s = model.stats
  const some = (n: number | null | undefined) => n != null && n > 0

  const stats =
    s === null
      ? []
      : [
          { k: 'throughput', v: `${(s.tps ?? 0).toFixed(1)} tok/s`, on: some(s.tps) },
          { k: 'first token', v: `${num(s.ttftMs)} ms`, on: some(s.ttftMs) },
          { k: 'requests', v: num(s.requests), on: some(s.requests) },
          { k: 'tokens out', v: num(s.outputTokens), on: some(s.outputTokens) },
          { k: 'tokens in', v: num(s.inputTokens), on: some(s.inputTokens) },
        ].filter((f) => f.on)

  return (
    <div className={cn(HERO, model.hot ? HERO_FILL_HOT : HERO_FILL)}>
      {/* Name and action on one line, attributes on the next. At half width
          they cannot share a line without the name being truncated to nothing,
          and the name is the part being identified. */}
      <div className="flex min-w-0 items-center gap-[0.5rem]">
        <Pulse on={model.hot} tone="accent" />
        <span className={HERO_NAME}>{model.name}</span>
        <EvictButton model={model} />
      </div>
      <div className="mt-[0.35rem] flex flex-wrap gap-[0.25rem]">
        {model.recipe !== '?' && <Chip tone="info">{model.recipe}</Chip>}
        {model.backend !== null && (
          <Chip tone={model.backend === 'rocm' ? 'ok' : 'muted'}>{model.backend}</Chip>
        )}
        {model.context !== null && <Chip>{num(model.context / 1024)}k ctx</Chip>}
        {model.sizeGb !== null && <Chip>{num(model.sizeGb, 1)} GB</Chip>}
      </div>

      {/* Only the figures that say something. Lemonade emits every one of
          these series for every loaded model, so an embedding model that has
          never been asked for a token still reports 0.0 tok/s and 0 ms to
          first token — and a TTS model would report those forever, because
          they do not mean anything for it. Rendering them produced five
          identical rows of noughts under five of the six kinds, which reads
          as broken instrumentation rather than as an idle model.

          Zero is dropped rather than shown because in every one of these the
          quantity is cumulative-or-latest: nothing has happened yet, which is
          what an absent row already says. */}
      {stats.length > 0 && (
        <div className="mt-[0.55rem]">
          <Measures items={stats} />
        </div>
      )}
    </div>
  )
}

/**
 * An installed model that is not in the slot, and the button that puts it
 * there. Shows what it managed last time it ran, which is the whole basis for
 * choosing between two chat models you already have.
 */
function ModelAlt({ model, replacing }: { model: Model; replacing: Model | null }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  return (
    <li className={ALT}>
      <span className={ALT_NAME} title={model.name}>
        {model.name}
      </span>
      <span className={ALT_META}>
        {model.sizeGb !== null && <span>{num(model.sizeGb, 1)} GB</span>}
        {/* Its throughput last time it ran — the one number that actually
            decides between two chat models you already have on disk. Requests
            are dropped here: they say how much you have used it, not how well
            it works, and the column has no room for both. */}
        {model.stats?.tps != null && model.stats.tps > 0 && (
          <span>{model.stats.tps.toFixed(0)} tok/s</span>
        )}
      </span>
      {error !== null && (
        <span className="text-danger" title={error}>
          failed
        </span>
      )}
      <Button
        type="button"
        variant="outline"
        size="sm"
        className={cn(QUIET_BTN, 'group-hover/alt:opacity-100')}
        disabled={busy}
        title={
          replacing === null
            ? `Load ${model.name}`
            : `Evict ${replacing.name} and load ${model.name}`
        }
        onClick={() => {
          setBusy(true)
          setError(null)
          void switchLemonadeModel({
            data: {
              from: replacing?.name ?? null,
              to: model.name,
              // Carry the incumbent's pinning forward rather than silently
              // changing whether the slot survives the next squeeze.
              pinned: replacing?.pinned ?? false,
            },
          })
            .then((r) => {
              if (!r.ok) setError(r.message)
              return router.invalidate()
            })
            .finally(() => {
              setBusy(false)
            })
        }}
      >
        {busy ? 'Switching…' : 'Switch'}
      </Button>
    </li>
  )
}

/**
 * Hands the VRAM and the file handle back.
 *
 * The file-handle half is the one that comes up: a model that is loaded cannot
 * be replaced on the Windows box, so a stuck download is often just this.
 */
function EvictButton({ model }: { model: Model }) {
  const router = useRouter()
  const [busy, setBusy] = useState(false)

  return (
    // Quieter still than the Switch buttons: six lit Evict buttons down the
    // widget competed with the six models they belong to, and evicting is a
    // thing you do occasionally rather than a thing you read.
    <Button
      type="button"
      variant="outline"
      size="sm"
      className={cn(QUIET_BTN, 'ml-auto py-[0.18rem] opacity-40 group-hover/hero:opacity-100')}
      disabled={busy}
      title={`Unload ${model.name}, leaving this slot empty`}
      onClick={() => {
        setBusy(true)
        void unloadLemonadeModel({ data: { model: model.name } })
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

/**
 * The bridge is diagnostics for Lemonade's panel, not a service anybody
 * watches — so it gets the same treatment as everyone else's neighbours.
 */
const LEMONADE_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { container: 'lemonade-logs' },
    label: 'Bridge logs',
    role: 'the process shipping the above',
    title: 'Lemonade log bridge',
    note: 'Deliberately a separate stream: this is the bridge’s own reconnects and gap warnings, and mixing them into Lemonade’s log would make the model server look like it was reporting network trouble it knows nothing about. Look here when the panel above goes quiet.',
  },
]
