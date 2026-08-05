import { useState } from 'react'
import { useRouter } from '@tanstack/react-router'

import {
  BarList,
  BigStat,
  Board,
  BoardGrid,
  Chip,
  Columns,
  Facts,
  Measures,
  Pulse,
  StatBand,
} from '../viz'
import { GrafanaLogs, LogDetails } from '../logs'
import { ReleaseNotes, UpgradeChain } from '../release-notes'
import { LinkRow, ServiceHead, type CompareRow } from '../service-head'
import { switchLemonadeModel, unloadLemonadeModel } from '../../server/lemonade'
import { compact, DASH, ms, num, pct } from '../../lib/dashboard/format'
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

/** The release-notes board, identical on all four tabs. */
function ReleaseBoard({ gap, span = 12 }: { gap: VersionGap; span?: 6 | 12 }) {
  const current = gap.behind.length === 0

  return (
    <Board
      title={current ? 'Release notes' : `${String(gap.behind.length)} to apply`}
      icon="≡"
      span={span}
      // Only when it is sharing a row: the grid is align-items:start, so an
      // unequal pair leaves a gap under the shorter one that reads as a
      // missing panel.
      fill={span === 6}
      aside={<span className="board-note">github releases</span>}
    >
      <UpgradeChain behind={gap.behind} />
      <ReleaseNotes
        releases={gap.releases}
        running={gap.installed}
        empty={gap.note ?? 'no published notes for this version'}
      />
      <p className="board-foot">
        {current ?
          'What the running version shipped. '
        : 'Everything between the running version and the newest release, oldest at the top. '}
        Parsed from the project’s own GitHub releases and shortened — open one for the detail, and
        the link inside goes to the full text.
      </p>
    </Board>
  )
}

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

        <ReleaseBoard gap={gap} span={6} />

        <Board title="Logs" icon="≡" span={12}>
          {/* Selected by STACK, not container. These lines were not produced on
              this box at all — the bridge in stacks/lemonade-logs reads
              Lemonade's WebSocket on the gaming PC and pushes them to Loki
              directly, so there is no podman container to name. */}
          <GrafanaLogs
            source={{ stack: 'lemonade' }}
            title="Lemonade server logs"
            foot={
              <p className="board-foot">
                Lemonade’s own log, streamed off the gaming PC over its <code>/logs/stream</code>{' '}
                WebSocket — the only log egress it has — and pushed to Loki by the bridge below.
                Timestamps are the ones Lemonade recorded, not the ones Loki received.
              </p>
            }
          />

          {/* The bridge is diagnostics for the panel above, not a service
              anybody watches. Collapsed, so it is one click away on the day the
              logs above stop arriving and invisible on every other day. */}
          <LogDetails
            summary="Bridge logs — the process shipping the above"
            source={{ container: 'lemonade-logs' }}
            title="Lemonade log bridge"
            foot={
              <p className="board-foot">
                Deliberately a separate stream: this is the bridge’s own reconnects and gap
                warnings, and mixing them into Lemonade’s log would make the model server look like
                it was reporting network trouble it knows nothing about. Look here when the panel
                above goes quiet.
              </p>
            }
          />
        </Board>
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
  const { gap, today, daily, window: total } = data
  const busy = data.inFlight !== null && data.inFlight > 0
  const first = daily[0]?.date ?? ''
  const last = daily[daily.length - 1]?.date ?? ''

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
          aside={
            <span className="board-live">
              <Pulse on={busy} tone="accent" />
              {busy ? `${num(data.inFlight)} in flight` : 'idle'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'today', v: volume(today) },
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
            height={64}
            empty="the gateway’s ledger is empty"
          />
          {daily.length > 0 && (
            <p className="colaxis">
              <span>{first.slice(5)}</span>
              <span>requests per day</span>
              <span>{last.slice(5)}</span>
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
          title="Who is calling"
          icon="◑"
          span={4}
          fill
          aside={<span className="board-note">tokens, {total.days}d</span>}
        >
          <BarList
            items={data.callers.map((c) => ({ label: c.label, value: c.value, display: compact(c.value) }))}
            tone="info"
            empty="no keyed traffic in the window"
          />
          <p className="board-foot">
            Named by their virtual key’s alias; an unaliased key shows as its hash. A caller missing
            from this list is idle, not gone.
          </p>
        </Board>

        {/* One table, not three panels. The routing table, "where the tokens
            went" and "latency by model" were all keyed by the same published
            name, so each was a third of an answer laid out as a whole one — and
            two of them were single-bar bar charts, which is a number wearing a
            chart's costume. Joined, a row says what a caller asks for, what
            that resolves to, and what it has actually cost to serve. */}
        <Board
          title="What resolves where"
          icon="⇄"
          span={8}
          fill
          aside={
            <span className="board-note">
              {data.routes.length} published · {total.days}d
            </span>
          }
        >
          {data.routes.length === 0 ?
            <p className="viz-empty">the gateway did not answer</p>
          : <div className="rtable">
              <div className="rtable-head" aria-hidden="true">
                <span>published</span>
                <span />
                <span>served by</span>
                <span>kind</span>
                <span>req</span>
                <span>tokens</span>
                <span>mean</span>
              </div>
              <ul>
                {data.routes.map((r) => (
                  <li key={r.name} className={r.requests === 0 ? 'rt-row rt-idle' : 'rt-row'}>
                    <span className="rt-name mono">{r.name}</span>
                    <span className="rt-arrow" aria-hidden="true">
                      →
                    </span>
                    <span className="rt-target mono" title={r.target}>
                      {r.target}
                      <em>{r.upstream}</em>
                    </span>
                    <Chip tone="muted">{r.mode}</Chip>
                    <span className="rt-n">{r.requests === 0 ? DASH : num(r.requests)}</span>
                    <span className="rt-n">{r.tokens === 0 ? DASH : compact(r.tokens)}</span>
                    <span className="rt-n">{ms(r.latencyMs)}</span>
                  </li>
                ))}
              </ul>
            </div>
          }
          <p className="board-foot">
            Left is what a caller asks for, right is the model Lemonade is told to load — different
            on purpose, so renaming a checkpoint on the gaming PC does not break Home Assistant’s
            config. Times are end to end, so they carry Lemonade’s cold-load penalty; the gateway’s
            own share of them is the <b>{ms(data.overheadMs)}</b> above.
          </p>
        </Board>

        <Board
          title="Tools models called"
          icon="⌗"
          span={4}
          fill
          aside={<span className="board-note">MCP, {total.days}d</span>}
        >
          {data.mcp.length === 0 ?
            <p className="viz-empty">no tool calls in the window</p>
          : <ul className="mcplist">
              {data.mcp.map((t) => (
                <li key={`${t.server}/${t.tool}`}>
                  <Chip tone="info">{t.server}</Chip>
                  <span className="mcp-tool mono" title={t.tool}>
                    {t.tool}
                  </span>
                  <span className="mcp-n">{num(t.calls)}</span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            The other direction: tools the gateway hands to a model mid-answer, counted when one was
            actually invoked. Registered servers with no calls do not appear.
          </p>
        </Board>

        <ReleaseBoard gap={gap} />

        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs source={{ container: 'litellm' }} title="LiteLLM logs" />

          {/* The three containers the gateway dials that are not Lemonade.
              None of them has a tab, none of them is worth a panel of its own,
              and every one of them is a plausible answer to "the gateway
              returned an error and its own log only says the upstream did".
              Folded, in the order a request would reach them. */}
          {NEIGHBOURS.map((n) => (
            <LogDetails
              key={n.container}
              summary={`${n.label} — ${n.role}`}
              source={{ container: n.container }}
              title={`${n.label} logs`}
              foot={<p className="board-foot">{n.note}</p>}
            />
          ))}
        </Board>
      </BoardGrid>
    </>
  )
}

/**
 * What sits behind the gateway besides the model server.
 *
 * These are the containers LiteLLM proxies TO — a web search tool, a tool
 * server, a vector store — so a failure in any of them surfaces to a caller as
 * a LiteLLM error, and LiteLLM's own log will only say that its upstream
 * refused. Listed here rather than inline because the set is a fact about the
 * stack, and it is the thing to extend when a fourth one is added.
 */
const NEIGHBOURS = [
  {
    container: 'searxng',
    label: 'SearXNG',
    role: 'the web search the gateway offers',
    note: 'Registered as the `searxng` search tool, so a model asking to search the web is asking this. It answers on the shared websearch bridge and never talks to a caller directly.',
  },
  {
    container: 'mcp-grocy',
    label: 'Grocy MCP',
    role: 'the local tool server it proxies',
    note: 'The one MCP server that runs on this box — TickTick is remote and logs nothing here. Every call counted in “tools models called” above passed through this container.',
  },
  {
    container: 'litellm-pgvector',
    label: 'pgvector connector',
    role: 'the RAG store behind /vector_store',
    note: 'Fronts pgvector in the shared pg cluster for LiteLLM’s vector-store API. Ingest failures land here rather than in the gateway’s log, which only sees the connector’s answer.',
  },
] as const

/** `29 req · 28k tok`, or an em dash for a day the gateway served nothing. */
function volume(v: { requests: number; tokens: number } | null): string {
  if (v === null || v.requests === 0) return DASH
  return `${num(v.requests)} req · ${compact(v.tokens)} tok`
}

// ── Open WebUI ─────────────────────────────────────────────────────────────

function OpenWebUiView({ data }: { data: Extract<AiData, { tab: 'open-webui' }> }) {
  const { gap, auth } = data

  return (
    <>
      <ServiceHead
        logo="/icon-open-webui.svg"
        name="Open WebUI"
        version={data.version}
        versionNote="the chat window"
        verdict={verdictOf(gap)}
        compare={compareOf(gap, 'a digest in the flake, against a moving main tag')}
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

      <StatBand>
        <BigStat
          label="Active users"
          value={num(data.users)}
          tone="ok"
          sub="seen in the last 3 minutes"
        />
        <BigStat
          label="Generating"
          value={num(data.generating)}
          tone={data.generating !== null && data.generating > 0 ? 'accent' : 'muted'}
          sub={
            <>
              <Pulse on={data.generating !== null && data.generating > 0} tone="accent" />
              models mid-answer
            </>
          }
        />
        <BigStat label="Models offered" value={String(data.models.length)} tone="info" sub="in the picker" />
        <BigStat
          label="Self-reported"
          value={data.latest === null || data.latest === data.version ? 'up to date' : data.latest}
          tone="muted"
          sub="its own update check"
        />
      </StatBand>

      <BoardGrid>
        <Board title="How you get in" icon="⚿" span={6} fill>
          <Facts
            rows={[
              { k: 'Identity provider', v: auth.oidc ?? 'none configured' },
              { k: 'Password form', v: auth.loginForm ? 'shown' : 'hidden' },
              { k: 'Straight to the IdP', v: auth.autoRedirect ? 'yes' : 'no' },
              { k: 'Self sign-up', v: auth.signup ? 'open' : 'closed' },
            ]}
          />
          <p className="board-foot">
            The login form is off, so the page redirects to Pocket ID rather than offering a
            password box that would be a second way in. The break-glass form is still reachable at{' '}
            <code>/auth?form=true</code> if the IdP is ever the thing that is down.
          </p>
        </Board>

        <Board
          title="Models in the picker"
          icon="▤"
          span={6}
          fill
          aside={<span className="board-note">as the chat sees them</span>}
        >
          {data.models.length === 0 ?
            <p className="viz-empty">could not read the model list</p>
          : <ul className="modellist">
              {data.models.map((m) => (
                <li key={m.id}>
                  <span className="model-name">{m.name}</span>
                  <span className="model-id mono">{m.id}</span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            These are the gateway’s models plus whatever presets have been saved on top — a name
            here that is not on LiteLLM’s routing table is a preset, not a model.
          </p>
        </Board>

        <ReleaseBoard gap={gap} />

        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs source={{ container: 'open-webui' }} title="Open WebUI logs" />
        </Board>
      </BoardGrid>
    </>
  )
}

// ── n8n ────────────────────────────────────────────────────────────────────

function N8nView({ data }: { data: Extract<AiData, { tab: 'n8n' }> }) {
  const { gap, counts } = data

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

      <StatBand>
        <BigStat label="Active workflows" value={num(counts.active)} tone="ok" sub="on a schedule or trigger" />
        <BigStat label="Total workflows" value={num(counts.total)} tone="info" sub="including drafts" />
        <BigStat
          label="Failed"
          value={num(counts.failed)}
          tone={counts.failed !== null && counts.failed > 0 ? 'bad' : 'muted'}
          sub="of the recent runs below"
        />
        <BigStat
          label="Latest release"
          value={gap.latest ?? DASH}
          tone="muted"
          sub={gap.behind.length === 0 ? 'running it' : `${String(gap.behind.length)} behind`}
        />
      </StatBand>

      <BoardGrid>
        <Board title="Recent runs" icon="⟳" span={6} fill>
          {data.runs.length === 0 ?
            <p className="viz-empty">{data.note ?? 'no recent executions'}</p>
          : <ul className="runs">
              {data.runs.map((r, i) => (
                <li key={`${r.name}-${String(i)}`} className={`runs-row runs-${statusTone(r.status)}`}>
                  <span className="runs-name">{r.name}</span>
                  <span className="runs-status">{r.status}</span>
                  <span className="runs-when">{r.ago}</span>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            The newest eight, whatever their outcome. n8n keeps the full history and the stack
            traces behind the Executions tab — this is only enough to notice.
          </p>
        </Board>

        <Board
          title="Workflows"
          icon="◫"
          span={6}
          fill
          aside={<span className="board-note">active first</span>}
        >
          {data.workflows.length === 0 ?
            <p className="viz-empty">{data.note ?? 'no workflows'}</p>
          : <ul className="modellist">
              {data.workflows.map((w) => (
                <li key={w.name}>
                  <span className="model-name">{w.name}</span>
                  <Chip tone={w.active ? 'ok' : 'muted'}>{w.active ? 'active' : 'inactive'}</Chip>
                </li>
              ))}
            </ul>
          }
          <p className="board-foot">
            {/* The draft/published split has bitten this box before: an edit
                lands on the draft and the schedule keeps running the published
                version, so "I changed it and nothing happened" is expected. */}
            Editing a workflow changes its draft. A scheduled run uses the last <b>published</b>{' '}
            version, so a change is not live until you publish it.
          </p>
        </Board>

        <ReleaseBoard gap={gap} />

        <Board title="Logs" icon="≡" span={12}>
          <GrafanaLogs source={{ container: 'n8n' }} title="n8n logs" />
        </Board>
      </BoardGrid>
    </>
  )
}

function statusTone(status: string): string {
  if (status === 'success') return 'ok'
  if (status === 'running' || status === 'waiting' || status === 'new') return 'live'
  return 'bad'
}
