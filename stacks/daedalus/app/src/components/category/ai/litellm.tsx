import type { AiData } from '../../../lib/dashboard/categories/ai'
import { compact, DASH, ms, num, pct } from '../../../lib/format'
import { GrafanaLogs } from '../../logs'
import { Changelog } from '../../release-notes'
import { freshnessRow, LinkRow, ServiceHead, verdictOf } from '../../service-head'
import { Board, BoardGrid, Chip, Columns, Measures, Pulse, RankRow } from '../../viz'
import { comparePinned } from './shared'

// `ReleaseBoard` is gone: it was `Changelog` with one of its two shapes, and
// the neighbour panels below needed the other.

// ── LiteLLM ────────────────────────────────────────────────────────────────

export function LitellmView({ data }: { data: Extract<AiData, { tab: 'litellm' }> }) {
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
        verdict={verdictOf(gap, data.freshness)}
        compare={[
          ...comparePinned(gap, 'a digest in the flake, against a moving main-stable tag'),
          ...freshnessRow(data.freshness),
        ]}
        lede={
          <>
            The only thing that knows who asked for what. Nothing here holds a model, so swapping
            Lemonade out is a config change and no caller notices.
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
              { k: 'today', v: volume(data.today) },
              { k: `${String(total.days)} days`, v: volume(total) },
              {
                k: 'failed',
                v:
                  total.requests === 0
                    ? DASH
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
            Counted from the gateway’s own ledger, which survives a restart. Its Prometheus counters
            do not. A day that saw a failure is underlined in red.
            {data.partial && ' The window has more rows than one page, so these are a lower bound.'}
          </p>
        </Board>

        <Board
          title="Tools models called"
          icon="hash"
          span={4}
          aside={
            <span className="board-note">
              {data.mcpServers.length === 0
                ? `MCP, ${String(total.days)}d`
                : data.mcpServers.map((s) => `${s.name} ${String(s.calls)}`).join(' · ')}
            </span>
          }
        >
          {data.mcp.length === 0 ? (
            <p className="viz-empty">no tool calls in the window</p>
          ) : (
            <ul className="itemlist">
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
          )}
          <p className="board-foot">
            The other direction: tools the gateway hands to a model mid-answer, counted when one was
            invoked. A registered server with no calls does not appear, and a tool whose counters
            were reset by a restart shows no time.
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
            twice the height of the traffic panel, so the two are paired with
            boards of their own size — stretching makes a row share one bottom
            edge, but it cannot invent content to fill the taller one with. */}
        <Board
          title="Who is calling"
          icon="◑"
          span={6}
          aside={<span className="board-note">requests, {total.days}d</span>}
        >
          {data.callers.length === 0 ? (
            <p className="viz-empty">no keyed traffic in the window</p>
          ) : (
            <ul className="ranks">
              {data.callers.map((c) => (
                <CallerRow
                  key={c.name}
                  caller={c}
                  max={data.callers[0]?.requests ?? 1}
                  today={todayDate}
                />
              ))}
            </ul>
          )}

          {/* Ranked by requests, not tokens, and that is the reason this box
              exists in the shape it does: a key that is rejected returns no
              tokens at all, so on a token ranking the eleven of them below
              scored zero and never appeared. */}
          {data.rejected.keys > 0 && (
            <p className="rejected">
              <b>{num(data.rejected.keys)}</b> keys never completed a request.{' '}
              <b>{num(data.rejected.requests)}</b> attempts, last{' '}
              {ago(data.rejected.last, todayDate)}.{' '}
              {data.rejected.live === 0 ? (
                'None of them exists on the gateway today.'
              ) : (
                <>
                  <b>{num(data.rejected.live)}</b> of them still exists on the gateway, which is a
                  fault rather than a stale credential.
                </>
              )}
            </p>
          )}

          <p className="board-foot">
            Named by their key’s alias; a key with none shows as its hash, and one the gateway no
            longer holds is marked <b>revoked</b>. Hover any name for what it is. A key that fails
            authentication never reaches a model, so it has no tokens and no model against it. The
            gateway is LAN-only, so every attempt above came from something in the house.
          </p>
        </Board>

        <Changelog gap={gap} span={6} />

        <Board title="Logs" icon="logs" span={12}>
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
            {n.version === null ? 'version unknown' : <span className="mono">{n.version}</span>}
          </span>
        }
        foot={<p className="board-foot">{n.note}</p>}
      />
      <Board
        title={`${n.label} logs`}
        icon="logs"
        span={6}
        aside={<span className="board-note">{n.role}</span>}
      >
        <GrafanaLogs source={{ container: n.container }} title={`${n.label} logs`} />
      </Board>
    </>
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
