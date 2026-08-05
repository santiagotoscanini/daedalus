import { useState, type ReactNode } from 'react'
import { useRouter } from '@tanstack/react-router'

// No `StatBand`/`BigStat` anywhere on these four pages any more: every one of
// them ended up saying either a number the panel below it states in context,
// or a number that is zero almost always and means nothing when it is not.
import { Board, BoardGrid, Chip, Columns, Measures, Pulse } from '../viz'
import { GrafanaLogs, LogDetails, type LogSource } from '../logs'
import { Changelog } from '../release-notes'
import { LinkRow, ServiceHead, type CompareRow } from '../service-head'
import { switchLemonadeModel, unloadLemonadeModel } from '../../server/lemonade'
import { compact, DASH, ms, num, pct, until } from '../../lib/dashboard/format'
import type { VersionGap } from '../../lib/dashboard/github'
import type { AiData } from '../../server/category'
import type { Tone } from '../viz'

// The AI pages — one per service, chosen by the sub-tab.
//
// Every one of them opens the same way, and that is deliberate: artwork, name,
// the version running, the verdict on whether that version is current, one
// sentence saying where this service sits in the chain, and the link you came
// to click. Four services whose UIs look nothing alike become four pages that
// are read the same way.
//
// Underneath, each is its own thing. Lemonade's page is about VRAM and what is
// resident; LiteLLM's is about traffic and routing; the two caller pages are
// mostly "is it configured the way I think it is". Forcing those into a shared
// layout is what the previous single-page version did, and it is why every
// service got a quarter of a row it could not say anything useful in.

export function AiView({ data }: { data: AiData }) {
  switch (data.tab) {
    case 'lemonade':
      return <LemonadeView data={data} />
    case 'litellm':
      return <LitellmView data={data} />
    case 'open-webui':
      return <OpenWebUiView data={data} />
    case 'n8n':
      return <N8nView data={data} />
  }
}

/**
 * The version verdict, from the release gap.
 *
 * One function rather than four copies because the phrasing is the argument:
 * "3 behind" is a fact you can act on, "update available" is a nag, and
 * "unknown" is what to say when GitHub would not answer rather than quietly
 * claiming to be current.
 */
function verdictOf(gap: VersionGap): { label: string; tone: Tone } {
  if (gap.installed === null || gap.latest === null) return { label: 'unknown', tone: 'muted' }
  if (gap.behind.length === 0) return { label: 'current', tone: 'ok' }
  return { label: `${String(gap.behind.length)} behind`, tone: 'warn' }
}

function compareOf(gap: VersionGap, note: string): CompareRow[] {
  return [
    {
      k: 'Latest',
      v: gap.latest,
      note:
        gap.latest === null ? 'GitHub did not answer'
        : gap.behind.length === 0 ? 'this is what is running'
        : `${String(gap.behind.length)} release${gap.behind.length === 1 ? '' : 's'} between them`,
    },
    { k: 'Pinned by', v: null, note },
  ]
}

// `ReleaseBoard` is gone: it was `Changelog` with one of its two shapes, and
// the neighbour panels below needed the other.


// ── Lemonade ───────────────────────────────────────────────────────────────

function LemonadeView({ data }: { data: Extract<AiData, { tab: 'lemonade' }> }) {
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
        compare={compareOf(gap, 'nothing here — it is installed on Windows, not in the flake')}
        lede={
          <>
            The only thing in this stack that holds weights, and the only one not on this box. Every
            caller reaches it through LiteLLM; it never sees them directly.
          </>
        }
        actions={
          <a className="btn btn-primary" href={data.baseUrl} target="_blank" rel="noreferrer">
            Open Lemonade ↗
          </a>
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
          icon="▤"
          span={6}
          fill
          aside={
            <span className="board-note">
              {installed} · {num(data.catalog.sizeGb, 1)} GB
            </span>
          }
        >
          {/* Only while something is actually downloading, and above the fold
              of everything else: it is the one thing here that is mid-change
              and the one thing that will look wrong if unexplained. */}
          {data.downloads.length > 0 && (
            <ul className="mdl-dl">
              {data.downloads.map((d) => (
                <li key={d.model}>
                  <span>{d.model}</span>
                  <span className="mono">
                    {d.status}
                    {d.percent === null ? '' : ` · ${num(d.percent)}%`}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {categories.length === 0 ?
            <p className="viz-empty">Lemonade did not answer</p>
          : categories.map((c) => <ModelKind key={c.type} kind={c} />)}

          {/* The build behind each runtime named above. Folded in here rather
              than given a panel of its own, which restated every runtime name
              a second time: what is worth knowing separately is only the build
              NUMBER, and it moves far more often than a Lemonade release does
              — it is the thing that changes how fast a model runs. */}
          {data.backends.length > 0 && (
            <p className="mbuilds">
              {data.backends.map((b) => (
                <span key={`${b.recipe}-${b.backend}`}>
                  {b.recipe}
                  {b.url === null ?
                    <span className="mono">{b.version}</span>
                  : <a className="mono" href={b.url} target="_blank" rel="noreferrer">
                      {b.version}
                    </a>
                  }
                </span>
              ))}
            </p>
          )}

          <p className="board-foot">
            One model of each kind stays in VRAM — Lemonade’s per-type limit — so picking a
            different chat model means putting down the current one. <b>Switch</b> does both in
            order, because a pinned model is exempt from eviction and the incoming load is refused
            outright if the slot is not freed first. Counts survive an eviction, so a model you
            have not run today still shows what it managed last time.
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
            <p className="board-foot">
              Lemonade’s own log, streamed off the gaming PC over its <code>/logs/stream</code>{' '}
              WebSocket — the only log egress it has — and pushed to Loki by the bridge below.
              Timestamps are the ones Lemonade recorded, not the ones Loki received.
            </p>
          }
          neighbours={LEMONADE_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}

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
    <details className="mkind">
      <summary>
        <span className="mkind-type">{kind.type}</span>
        {/* The one thing that is a fault rather than a statistic, so it is the
            one thing that gets a colour in a collapsed row. */}
        {resident === null && <span className="mkind-free">slot free</span>}
        {/* Abbreviated, because these are a sense of scale rather than
            quantities — 976k answers "has anything been using these", and
            976,228 answers it no better while costing half the row. */}
        <span className="mkind-agg">
          <span>{kind.models.length === 1 ? '1 model' : `${String(kind.models.length)} models`}</span>
          {size > 0 && <span>{num(size, 1)} GB</span>}
          {requests > 0 && <span>{compact(requests)} req</span>}
          {tokens > 0 && <span>{compact(tokens)} tok</span>}
        </span>
      </summary>

      <div className="mkind-body">
        {resident === null ?
          <p className="mkind-empty">nothing loaded — the next request will cold-load one</p>
        : <ModelHero model={resident} />}

        {others.length > 0 && (
          <ul className="malts">
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
    <p className="hoststrip">
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
          live.memGb === null || host.ramGb === null ?
            host.ramGb === null ?
              DASH
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
        note="its Windows metrics backend returns “not implemented”, where its macOS and Linux ones do not — so this is a gap in the port, not in the card"
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
    <span className={muted === true ? 'hfact hfact-muted' : 'hfact'} tabIndex={0}>
      {short}
      <span className="hfact-card" role="tooltip">
        <span className="hfact-detail">{detail}</span>
        {note !== undefined && <span className="hfact-note">{note}</span>}
      </span>
    </span>
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
    s === null ? []
    : [
        { k: 'throughput', v: `${(s.tps ?? 0).toFixed(1)} tok/s`, on: some(s.tps) },
        { k: 'first token', v: `${num(s.ttftMs)} ms`, on: some(s.ttftMs) },
        { k: 'requests', v: num(s.requests), on: some(s.requests) },
        { k: 'tokens out', v: num(s.outputTokens), on: some(s.outputTokens) },
        { k: 'tokens in', v: num(s.inputTokens), on: some(s.inputTokens) },
      ].filter((f) => f.on)

  return (
    <div className={model.hot ? 'mhero mhero-hot' : 'mhero'}>
      {/* Name and action on one line, attributes on the next. At half width
          they cannot share a line without the name being truncated to nothing,
          and the name is the part being identified. */}
      <div className="mhero-id">
        <Pulse on={model.hot} tone="accent" />
        <span className="mhero-name">{model.name}</span>
        <EvictButton model={model} />
      </div>
      <div className="mhero-tags">
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
      {stats.length > 0 && <Measures items={stats} />}
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
    <li className="malt">
      <span className="malt-name" title={model.name}>
        {model.name}
      </span>
      <span className="malt-meta">
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
        <span className="bad-text" title={error}>
          failed
        </span>
      )}
      <button
        type="button"
        className="btn btn-ghost"
        disabled={busy}
        title={
          replacing === null ?
            `Load ${model.name}`
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
        {busy ? '· switching…' : 'Switch'}
      </button>
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
    <button
      type="button"
      className="btn btn-ghost mhero-evict"
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
      {busy ? '· evicting…' : 'Evict'}
    </button>
  )
}

// ── LiteLLM ────────────────────────────────────────────────────────────────

function LitellmView({ data }: { data: Extract<AiData, { tab: 'litellm' }> }) {
  const { gap, daily, window: total } = data
  const busy = data.inFlight !== null && data.inFlight > 0
  const firstDate = daily[0]?.date ?? ''
  // The window's last day IS today, since the window ends at today — and it is
  // the reference every "2d ago" below is measured against, rather than the
  // browser's clock, which would not agree with the server's at midnight.
  const todayDate = daily[daily.length - 1]?.date ?? ''

  return (
    <>
      <ServiceHead
        logo="/icon-litellm.png"
        name="LiteLLM"
        version={data.version}
        versionNote="one OpenAI API for everything"
        verdict={verdictOf(gap)}
        compare={compareOf(gap, 'a digest in the flake, against a moving main-stable tag')}
        lede={
          <>
            The only thing that knows who asked for what. Nothing here holds a model — swapping
            Lemonade out is a config change here and no caller notices.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://litellm.toscanini.me/ui"
            target="_blank"
            rel="noreferrer"
          >
            Open the admin UI ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.litellm.ai/docs/simple_proxy' },
          { label: 'Model hub', href: 'https://litellm.toscanini.me/ui/model_hub_table' },
          { label: 'GitHub', href: 'https://github.com/BerriAI/litellm' },
        ]}
      />

      {/* No headline band. Four stat cards spent the width of the page on
          "requests today: 18" and "failed today: 0" — one figure each, most of
          them zero most of the time, none of them worth the glance they were
          demanding. The same numbers are a measure line inside the panel whose
          chart they describe, which is also where they can be read AGAINST that
          chart instead of a screen away from it. */}
      <BoardGrid>
        <Board
          title="Traffic"
          icon="◇"
          span={8}
          // Both halves of a pair fill: which one is taller depends on data
          // (how many callers, how many workflows), so it cannot be decided here.
          fill
          aside={
            <span className="board-live">
              <Pulse on={busy} tone="accent" />
              {busy ? `${num(data.inFlight)} in flight` : 'idle'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'today', v: volume(data.today) },
              { k: `${String(total.days)} days`, v: volume(total) },
              {
                k: 'failed',
                v:
                  total.requests === 0 ?
                    DASH
                  : `${num(total.failed)} · ${pct((total.failed / total.requests) * 100)}`,
                tone: total.failed > 0 ? 'bad' : undefined,
              },
              // The one latency figure on this page that is actually about the
              // gateway. Every other one is end-to-end and therefore mostly
              // Lemonade, and this is the number that says so — three lines of
              // caption replaced by the measurement they were describing.
              { k: 'gateway adds', v: ms(data.overheadMs) },
            ]}
          />

          <Columns
            points={daily.map((d) => ({
              // Month-day only: the year is the same for every column.
              label: d.date.slice(5),
              value: d.requests,
              display:
                `${num(d.requests)} requests · ${num(d.tokens)} tokens` +
                (d.failed > 0 ? ` · ${num(d.failed)} failed` : ''),
              flag: d.failed > 0,
            }))}
            height={112}
            empty="the gateway’s ledger is empty"
          />
          {daily.length > 0 && (
            <p className="colaxis">
              <span>{firstDate.slice(5)}</span>
              <span>requests per day</span>
              <span>{todayDate.slice(5)}</span>
            </p>
          )}

          <p className="board-foot">
            {data.endpoints.length > 0 && (
              <span className="endpoints">
                {data.endpoints.map((e) => (
                  <span key={e.label}>
                    {e.label} <b>{num(e.value)}</b>
                  </span>
                ))}
              </span>
            )}
            Counted from the gateway’s own ledger, which survives a restart — its Prometheus
            counters do not. A day that saw a failure is underlined in red.
            {data.partial && ' The window has more rows than one page, so these are a lower bound.'}
          </p>
        </Board>

        <Board
          title="Tools models called"
          icon="⌗"
          span={4}
          fill
          aside={
            <span className="board-note">
              {data.mcpServers.length === 0 ?
                `MCP, ${String(total.days)}d`
              : data.mcpServers.map((s) => `${s.name} ${String(s.calls)}`).join(' · ')}
            </span>
          }
        >
          {data.mcp.length === 0 ?
            <p className="viz-empty">no tool calls in the window</p>
          : <ul className="itemlist">
              {data.mcp.map((t) => (
                <li key={`${t.server}/${t.tool}`}>
                  <Chip tone="info">{t.server}</Chip>
                  <span className="item-main mono" title={t.tool}>
                    {t.tool}
                  </span>
                  {/* The tool's own time, which is the only latency on this
                      page that is NOT mostly Lemonade — a tool call is the
                      gateway talking to a container on this box, so tens of
                      milliseconds is what right looks like. */}
                  <span className="item-side">{ms(t.latencyMs)}</span>
                  <span className="item-n">{num(t.calls)}</span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            The other direction: tools the gateway hands to a model mid-answer, counted when one was
            actually invoked. A registered server with no calls does not appear, and a tool whose
            counters were reset by a restart shows no time.
          </p>
        </Board>

        {/* The one axis on this page worth a panel of this size. What a
            published name resolves to is a fact you configured — the checkpoint
            is on a machine in the next room and the mapping does not change on
            its own — so the routing table this replaced said nothing you did
            not already know, in nine rows, six of which were idle. Who is
            calling cannot be known from anywhere else.

            It also opens the second row rather than sharing the first, and that
            is a layout decision rather than an editorial one: it runs to about
            twice the height of the traffic panel, and the grid is
            align-items:start, so pairing the two left a screen-height hole
            under the shorter one. Boards here are paired by height — the two
            tall ones together, the two short ones together — because a `fill`
            can stretch a box but cannot invent content to put in it. */}
        <Board
          title="Who is calling"
          icon="◑"
          span={6}
          fill
          aside={<span className="board-note">requests, {total.days}d</span>}
        >
          {data.callers.length === 0 ?
            <p className="viz-empty">no keyed traffic in the window</p>
          : <ul className="ranks">
              {data.callers.map((c) => (
                <CallerRow key={c.name} caller={c} max={data.callers[0]?.requests ?? 1} today={todayDate} />
              ))}
            </ul>
          }

          {/* Ranked by requests, not tokens, and that is the reason this box
              exists in the shape it does: a key that is rejected returns no
              tokens at all, so on a token ranking the eleven of them below
              scored zero and never appeared. */}
          {data.rejected.keys > 0 && (
            <p className="rejected">
              <b>{num(data.rejected.keys)}</b> keys never completed a request —{' '}
              <b>{num(data.rejected.requests)}</b> attempts, last{' '}
              {ago(data.rejected.last, todayDate)}.{' '}
              {data.rejected.live === 0 ?
                'None of them exists on the gateway today.'
              : <>
                  <b>{num(data.rejected.live)}</b> of them still exists on the gateway, which is a
                  fault rather than a stale credential.
                </>
              }
            </p>
          )}

          <p className="board-foot">
            Named by their key’s alias; a key with none shows as its hash, and one the gateway no
            longer holds is marked <b>revoked</b> — hover any name for what it is. A key that fails
            authentication never reaches a model, so it has no tokens and no model against it. The
            gateway is LAN-only, so every attempt above came from something in the house.
          </p>
        </Board>

        <Changelog gap={gap} span={6} />

        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs source={{ container: 'litellm' }} title="LiteLLM logs" />
        </Board>

        {/* The three containers the gateway dials, each as a pair: what a
            re-pull would bring, and what it has been saying. They used to be
            three folded log frames and nothing else, which meant three pinned
            services could drift a year behind with nothing on this dashboard
            reporting it — the logs were there, the updates were not. */}
        {data.neighbours.map((n) => (
          <NeighbourPair key={n.container} n={n} />
        ))}
      </BoardGrid>
    </>
  )
}

/**
 * A container standing next to the one this tab is about.
 *
 * When a service's upstream breaks, the symptom arrives as a failure in the
 * service you were watching, whose own log says only that its upstream
 * refused. So a tab can carry its neighbours' logs, folded: one click away on
 * the day the main panel goes quiet, out of the way on every other day.
 *
 * ── the bar for being listed here ─────────────────────────────────────────
 *
 * A neighbour must have **nowhere else on this dashboard to be read**. Every
 * service in this category already has its own tab with its own log panel, so
 * listing LiteLLM under Open WebUI or n8n does not add a stream — it adds a
 * second copy of one, two tabs away from the page that owns it. And `pg` is
 * the whole box's database: it is behind Nextcloud, Immich, the *arrs, every
 * app on the platform. A container that is everyone's neighbour is nobody's.
 *
 * What passes: searxng, mcp-grocy and litellm-pgvector under LiteLLM, and the
 * log bridge under Lemonade. None of those has a tab, none is worth one, and
 * each is a plausible answer to "it errored and its own log only blamed its
 * upstream". That is the whole list — Open WebUI and n8n have no neighbour
 * meeting it, so they carry none.
 */
type Neighbour = {
  container: string
  label: string
  /** Completes “<label> — …”, so it says what this container IS to the tab. */
  role: string
  note: string
  /** Only when the panel heading should differ from `<label> logs`. */
  title?: string
}

/**
 * The logs board: the service's own stream, and its neighbours' underneath.
 *
 * `neighbours` here is the LIGHT kind — a container whose only question is
 * "what did it say", folded away. LiteLLM's three are the heavy kind and get
 * `NeighbourBoards` instead, because they also have updates nobody was
 * reporting.
 */
function LogBoard({
  source,
  title,
  foot,
  neighbours = [],
}: {
  source: LogSource
  title: string
  foot?: ReactNode
  neighbours?: readonly Neighbour[]
}) {
  return (
    <Board title="Logs" icon="≡" span={12}>
      <GrafanaLogs source={source} title={title} foot={foot} />
      {neighbours.map((n) => (
        <LogDetails
          key={n.container}
          summary={`${n.label} — ${n.role}`}
          source={{ container: n.container }}
          title={n.title ?? `${n.label} logs`}
          foot={<p className="board-foot">{n.note}</p>}
        />
      ))}
    </Board>
  )
}

/**
 * The bridge is diagnostics for Lemonade's panel, not a service anybody
 * watches — so it gets the same treatment as everyone else's neighbours.
 */
const LEMONADE_NEIGHBOURS: readonly Neighbour[] = [
  {
    container: 'lemonade-logs',
    label: 'Bridge logs',
    role: 'the process shipping the above',
    title: 'Lemonade log bridge',
    note: 'Deliberately a separate stream: this is the bridge’s own reconnects and gap warnings, and mixing them into Lemonade’s log would make the model server look like it was reporting network trouble it knows nothing about. Look here when the panel above goes quiet.',
  },
]

type NeighbourData = Extract<AiData, { tab: 'litellm' }>['neighbours'][number]

/**
 * One of the gateway's neighbours, as a pair of half-width boards.
 *
 * Changelog on the left, log on the right, because those are the only two
 * things ever wanted from a container with no page of its own: what would
 * change if I updated it, and what has it been saying. The title carries the
 * verdict, so the row answers "is anything here behind" before it is read.
 *
 * These were three folded log frames and nothing else, which was the gap: the
 * logs were on the page and the UPDATES were not, so three pinned services
 * could drift a year behind with nothing on this dashboard reporting it.
 */
function NeighbourPair({ n }: { n: NeighbourData }) {
  const behind = n.gap?.behind.length ?? n.build?.behind.length ?? 0
  const unit =
    n.gap !== null ? (behind === 1 ? 'release behind' : 'releases behind') : 'commits behind'
  const count = String(behind)

  return (
    <>
      <Changelog
        gap={n.gap}
        build={n.build}
        span={6}
        title={behind === 0 ? `${n.label} — current` : `${n.label} — ${count} ${unit}`}
        aside={
          <span className="board-note">
            {n.version === null ?
              'version unknown'
            : <span className="mono">{n.version}</span>}
          </span>
        }
        foot={<p className="board-foot">{n.note}</p>}
      />
      <Board
        title={`${n.label} logs`}
        icon="≡"
        span={6}
        fill
        aside={<span className="board-note">{n.role}</span>}
      >
        <GrafanaLogs source={{ container: n.container }} title={`${n.label} logs`} />
      </Board>
    </>
  )
}

/**
 * One row of a ranking, in two lines.
 *
 * The bar carries the comparison — the whole question a ranking answers is
 * which of these is the big one — and the line under it carries everything the
 * bar cannot: what it cost, how slowly it went, when it was last seen. A bar
 * list alone said only "n8n is the big one", which was true on the first read
 * and had nothing to add on any later one.
 *
 * Shared by the gateway's callers and n8n's workflows because they are the
 * same object: a named thing, a count worth comparing, and four facts that
 * only make sense next to it.
 *
 * `note` is the answer to "what IS this row" — a bare hash, a name that turns
 * out to be six services sharing one credential — and it hangs off the name
 * rather than the caption, where it would have to be written once per case and
 * read every time. `badges` are for the states that change what the numbers
 * mean: a key the gateway no longer holds, a schedule that has stopped firing,
 * runs that were all against a version somebody has since edited. A list
 * rather than one, because those are independent — a workflow can be both
 * stalled and unpublished, and picking one to show would hide the other.
 */
function RankRow({
  name,
  note = null,
  badges = [],
  value,
  max,
  meta,
}: {
  name: string
  note?: string | null
  badges?: readonly { text: string; tone: 'warn' | 'muted'; why?: string }[]
  value: number
  max: number
  meta: ReactNode
}) {
  return (
    <li className="rank">
      <span className={note === null ? 'rank-name' : 'rank-name rank-noted'}>
        <span title={note ?? name}>{name}</span>
        {badges.map((b) => (
          <em
            key={b.text}
            className={b.tone === 'muted' ? 'is-muted' : undefined}
            title={b.why ?? note ?? undefined}
          >
            {b.text}
          </em>
        ))}
      </span>
      <span className="rank-track">
        <span className="rank-fill" style={{ width: `${String(Math.max(1.5, (value / max) * 100))}%` }} />
      </span>
      <span className="rank-n">{num(value)}</span>
      <span className="rank-meta">{meta}</span>
    </li>
  )
}

type Caller = Extract<AiData, { tab: 'litellm' }>['callers'][number]

/**
 * One caller.
 *
 * Failures get the only colour in the row, and only when there are any. A
 * caller that works is the normal case and does not need to be decorated to
 * say so.
 */
function CallerRow({ caller, max, today }: { caller: Caller; max: number; today: string }) {
  return (
    <RankRow
      name={caller.name}
      note={caller.note}
      badges={caller.live ? [] : [{ text: 'revoked', tone: 'warn' } as const]}
      value={caller.requests}
      max={max}
      meta={
        <>
          {caller.tokens > 0 && <span>{compact(caller.tokens)} tok</span>}
          {caller.latencyMs !== null && <span>{ms(caller.latencyMs)}</span>}
          {caller.failed > 0 && <span className="bad-text">{num(caller.failed)} failed</span>}
          {/* One name and a count. A caller reaching a single model is the
              norm, the master key reaches seven, and two full model names
              wrapped this line onto a second row for the one caller that did —
              the rest is a hover away. */}
          {caller.models[0] !== undefined && (
            <span className="mono" title={caller.models.join(', ')}>
              {caller.models[0]}
              {caller.models.length > 1 && ` +${String(caller.models.length - 1)}`}
            </span>
          )}
          <span>{ago(caller.last, today)}</span>
        </>
      }
    />
  )
}

/**
 * A ledger date as a phrase.
 *
 * Days rather than `since`, because the ledger's resolution IS a day: it knows
 * a key called on the 3rd, not at what time, and "2 days ago" is the strongest
 * true statement available. Computed against a date passed in rather than
 * against `Date.now()` — this page renders on the server and hydrates in the
 * browser, and a relative time derived from two different clocks is a
 * hydration mismatch waiting for midnight.
 */
function ago(date: string | null, today: string): string {
  if (date === null || date === '') return DASH
  const days = Math.round((Date.parse(today) - Date.parse(date)) / 86400_000)
  if (!Number.isFinite(days)) return date
  if (days <= 0) return 'today'
  if (days === 1) return 'yesterday'
  return `${String(days)}d ago`
}

/** `29 req · 28k tok`, or an em dash for a day the gateway served nothing. */
function volume(v: { requests: number; tokens: number } | null): string {
  if (v === null || v.requests === 0) return DASH
  return `${num(v.requests)} req · ${compact(v.tokens)} tok`
}

// ── Open WebUI ─────────────────────────────────────────────────────────────

function OpenWebUiView({ data }: { data: Extract<AiData, { tab: 'open-webui' }> }) {
  const { gap, counts } = data
  const busy = data.generating !== null && data.generating > 0

  return (
    <>
      <ServiceHead
        logo="/icon-open-webui.svg"
        name="Open WebUI"
        version={data.version}
        versionNote="the chat window"
        verdict={verdictOf(gap)}
        compare={[
          ...compareOf(gap, 'a digest in the flake, against a moving main tag'),
          // Its own update check, which used to be a whole stat card saying
          // "up to date". It is a second opinion on the line above it, so it
          // belongs beside that line — and it only earns a sentence when the
          // two disagree.
          {
            k: 'Its own check',
            v: data.selfLatest,
            note:
              data.selfLatest === null ? 'it could not reach GitHub either'
              : data.selfLatest === data.version ? 'agrees: this is current'
              : 'what the app itself reports as newest',
          },
        ]}
        lede={
          <>
            The one service here a person types into. It talks to LiteLLM like any other OpenAI
            client, so it sees whatever the gateway publishes and nothing more.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://chat.toscanini.me"
            target="_blank"
            rel="noreferrer"
          >
            Open the chat ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.openwebui.com/' },
          { label: 'GitHub', href: 'https://github.com/open-webui/open-webui' },
        ]}
      />

      {/* No headline band. It held four cards, and all four were either a
          number this page states better in context (models offered, sitting a
          few pixels above the list of them) or a number that is zero almost
          always and means nothing when it is not (users seen in the last three
          minutes, on a one-account instance). */}
      <BoardGrid>
        <Board
          title="What the chat can reach"
          icon="▤"
          span={6}
          fill
          aside={
            <span className="board-live">
              <Pulse on={busy} tone="accent" />
              {busy ? `${num(data.generating)} mid-answer` : 'idle'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'models', v: String(counts.models) },
              { k: 'tool servers', v: String(counts.tools) },
              { k: 'knowledge', v: String(counts.knowledge) },
            ]}
          />

          {data.reach.length === 0 ?
            <p className="viz-empty">{data.note ?? 'nothing registered'}</p>
          : <ul className="itemlist">
              {data.reach.map((r) => (
                <li key={`${r.kind}-${r.name}`}>
                  <Chip tone={r.kind === 'model' ? 'info' : r.kind === 'tool' ? 'accent' : 'muted'}>
                    {r.kind}
                  </Chip>
                  <span className="item-main">{r.name}</span>
                  <span
                    className={r.flag ? 'item-side bad-text' : 'item-side'}
                    title={r.detail}
                  >
                    {r.detail}
                  </span>
                </li>
              ))}
            </ul>
          }

          <p className="board-foot">
            Read back from the running instance, not from the config that was meant to produce it —
            which is the only way to catch the two ways these disappear quietly. An env-backed
            setting the database had already overridden leaves the models list short, and a virtual
            key not permitted to reach an MCP server makes its tools return an empty list rather
            than an error. A knowledge base holding no files is marked: it answers nothing, and says
            nothing about it.
          </p>
        </Board>

        {/* Three panels, and the sign-in readback is deliberately not one of
            them. It was four facts that are declared in the stack and change
            when somebody edits nix — an identity provider, a login form that
            is off, a sign-up that is closed — so it could only ever agree with
            what you already wrote. */}
        <Changelog gap={gap} span={6} />

        {/* No neighbours. Everything this app dials either has its own tab
            (LiteLLM), is already folded under that tab (searxng), or is the
            whole box's database. See the bar on `Neighbour`. */}
        <LogBoard source={{ container: 'open-webui' }} title="Open WebUI logs" />
      </BoardGrid>
    </>
  )
}

// ── n8n ────────────────────────────────────────────────────────────────────

type N8nFlow = Extract<AiData, { tab: 'n8n' }>['flows'][number]

/**
 * The states a workflow can be in that change what its numbers mean.
 *
 * Independent, so this returns a list rather than picking one — a workflow can
 * be both stalled and unpublished, and the second would explain the first.
 * Warn for anything wanting a decision; muted for `off`, which is not a fault
 * but the reason the row has no recent runs. Colouring that would make every
 * deliberately-parked workflow look broken.
 */
function badgesFor(f: N8nFlow): { text: string; tone: 'warn' | 'muted'; why?: string }[] {
  const out: { text: string; tone: 'warn' | 'muted'; why?: string }[] = []
  if (f.stalled) out.push({ text: 'stalled', tone: 'warn', why: 'kept a cadence, then missed it' })
  if (f.active === true && f.runs === 0)
    out.push({ text: 'never run', tone: 'warn', why: 'switched on and has not fired in the window' })
  if (f.unpublished)
    out.push({ text: 'unpublished', tone: 'warn', why: 'edited since the version the schedule runs' })
  if (f.active === false) out.push({ text: 'off', tone: 'muted', why: 'switched off in n8n' })
  return out
}

function N8nView({ data }: { data: Extract<AiData, { tab: 'n8n' }> }) {
  const { gap, window: total, daily, flows } = data
  const firstDate = daily[0]?.date ?? ''
  const lastDate = daily[daily.length - 1]?.date ?? ''

  return (
    <>
      <ServiceHead
        logo="/icon-n8n.png"
        name="n8n"
        version={data.version}
        versionNote="pinned in the flake"
        verdict={verdictOf(gap)}
        compare={compareOf(gap, 'an exact tag in stacks/n8n — bump it there')}
        lede={
          <>
            Scheduled workflows, several of which call the gateway. Nothing here runs on a person
            being awake, which is why a failed run is worth seeing on a dashboard.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://n8n.toscanini.me"
            target="_blank"
            rel="noreferrer"
          >
            Open n8n ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.n8n.io/' },
          { label: 'Releases', href: 'https://github.com/n8n-io/n8n/releases' },
        ]}
      />

      {/* No headline band, for the same reason the gateway lost its: three of
          the four cards were counts of things listed a few pixels below, and
          the fourth repeated the version verdict already in the header. */}
      <BoardGrid>
        <Board
          title="Runs"
          icon="⟳"
          span={8}
          fill
          aside={
            <span className="board-live">
              <Pulse on={total.running > 0} tone="accent" />
              {total.running > 0 ? `${num(total.running)} running` : 'idle'}
            </span>
          }
        >
          <Measures
            items={[
              { k: `${String(total.days)} days`, v: `${num(total.runs)} runs` },
              {
                k: 'failed',
                v:
                  total.runs === 0 ? DASH
                  : `${num(total.failed)} · ${pct((total.failed / total.runs) * 100, 1)}`,
                tone: total.failed > 0 ? 'bad' : undefined,
              },
              { k: 'typical run', v: ms(total.medianMs) },
              { k: 'workflows seen', v: String(flows.length) },
            ]}
          />

          <Columns
            points={daily.map((d) => ({
              // Month-day only: the year is the same for every column.
              label: d.date.slice(5),
              value: d.runs,
              display: `${num(d.runs)} run${d.runs === 1 ? '' : 's'}${d.failed > 0 ? ` · ${num(d.failed)} failed` : ''}`,
              flag: d.failed > 0,
            }))}
            height={112}
            empty={data.note ?? 'no executions in the window'}
          />
          {daily.length > 0 && (
            <p className="colaxis">
              <span>{firstDate.slice(5)}</span>
              <span>runs per day</span>
              <span>{lastDate.slice(5)}</span>
            </p>
          )}

          {/* Few enough to name, which is the whole point of naming them: one
              failure a fortnight is a thing to go and read, not a rate. */}
          {data.failures.length > 0 && (
            <p className="rejected">
              {data.failures.map((f, i) => (
                <span key={`${f.name}-${String(i)}`}>
                  {i > 0 && ' · '}
                  <b>{f.name}</b> failed {f.ago}
                </span>
              ))}
            </p>
          )}

          <p className="board-foot">
            Counted from n8n’s own execution history, which it prunes on a schedule — so this window
            is what n8n still holds, and an empty column early on may be forgetting rather than
            silence. A day that saw a failure is underlined in red; the stack trace is behind the
            Executions tab.
            {data.partial && ' There were more executions than this fetched, so these are a lower bound.'}
          </p>
        </Board>

        <Board
          title="Workflows"
          icon="◫"
          span={4}
          fill
          aside={<span className="board-note">runs, {total.days}d</span>}
        >
          {flows.length === 0 ?
            <p className="viz-empty">{data.note ?? 'nothing has run in the window'}</p>
          : <ul className="ranks">
              {flows.map((f) => (
                <RankRow
                  key={f.id}
                  name={f.name ?? f.id.slice(0, 8)}
                  note={f.name === null ? `ran in this window, and no longer exists` : null}
                  badges={badgesFor(f)}
                  value={f.runs}
                  max={flows[0]?.runs ?? 1}
                  meta={
                    <>
                      {f.runs === 0 ?
                        <span className="bad-text">nothing in {total.days} days</span>
                      : <>
                          {f.medianMs !== null && <span>{ms(f.medianMs)}</span>}
                          {/* `until`, not `ms`: a cadence is a period, and the
                              latency formatter tops out at minutes — a daily
                              schedule read "1440m 0s". */}
                          {f.everyMs !== null && <span>every {until(f.everyMs / 1000)}</span>}
                          {f.failed > 0 && <span className="bad-text">{num(f.failed)} failed</span>}
                          <span>{f.ago}</span>
                        </>
                      }
                    </>
                  }
                />
              ))}
            </ul>
          }

          <p className="board-foot">
            {/* Three of the four badges are states nothing else reports: a
                schedule that quietly stopped, a workflow switched on that has
                never fired, and a draft that has drifted ahead of what the
                schedule actually runs. None of them produces an error. */}
            Everything that ran in the window, plus everything switched on that should have.{' '}
            <b>stalled</b> kept a cadence and has since missed more than two of them;{' '}
            <b>never run</b> is on and has not fired at all; <b>unpublished</b> has been edited
            since it was last published, so the runs above it are the old version — that one is why
            &ldquo;I changed it and nothing happened&rdquo;. <b>off</b> is switched off and explains
            the silence rather than reporting it.
            {data.archived > 0 &&
              ` ${String(data.archived)} archived workflow${data.archived === 1 ? '' : 's'} are left out — they cannot run.`}
            {data.nameNote !== null && ` ${data.nameNote}`}
          </p>
        </Board>

        <Changelog gap={gap} />

        {/* No neighbours, same bar: pg is the whole box's, and the gateway
            its AI steps call has a tab of its own. */}
        <LogBoard source={{ container: 'n8n' }} title="n8n logs" />
      </BoardGrid>
    </>
  )
}
