import { GrafanaLogs } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { Board, Columns, Measures, Pulse } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { compact, DASH, ms, num, pct } from '../../../lib/format'
import type { LitellmData } from '../data/litellm'
import type { LitellmFacts } from './litellm'
import {
  AXIS,
  CAPTION,
  EMPTY,
  FOOT,
  ITEM,
  ITEM_MAIN,
  ITEM_N,
  ITEM_SIDE,
  ITEMS,
  LIVE,
  MONO,
  NOTE,
} from './shared'

export function TrafficBoard({ f }: { f: LitellmFacts }) {
  const { data, daily, total, busy, firstDate, todayDate } = f
  return (
    <Board
      title="Traffic"
      icon="◇"
      span={8}
      aside={
        <span className={LIVE}>
          <Pulse on={busy} tone="accent" />
          {busy ? `${num(data.inFlight)} in flight` : 'idle'}
        </span>
      }
    >
      <Measures
        items={[
          { k: 'Today', v: volume(data.today) },
          { k: `${String(total.days)} days`, v: volume(total) },
          {
            k: 'Failed',
            v:
              total.requests === 0
                ? DASH
                : `${num(total.failed)} · ${pct((total.failed / total.requests) * 100)}`,
            tone: total.failed > 0 ? 'bad' : undefined,
          },
          // The one latency figure on this page that is actually about the
          // gateway. Every other one is end-to-end and therefore mostly the
          // model server, and this is the number that says so.
          { k: 'Gateway adds', v: ms(data.overheadMs) },
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
        tone="muted"
        empty="the gateway’s ledger is empty"
      />
      {daily.length > 0 && (
        <p className={AXIS}>
          <span>{firstDate.slice(5)}</span>
          <span>requests per day</span>
          <span>{todayDate.slice(5)}</span>
        </p>
      )}

      {/* The per-endpoint counts and the lower-bound warning are readings, so
          they stay visible; only the paragraph about the ledger folds. */}
      {data.endpoints.length > 0 && (
        <p
          className={cn(
            CAPTION,
            // An even grid rather than a wrapping line: a wrap left one endpoint
            // alone on a second row.
            'grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-1 [&_b]:font-semibold [&_b]:text-subdued [&_b]:tabular-nums',
          )}
        >
          {data.endpoints.map((e) => (
            <span key={e.label} className="flex justify-between gap-3">
              <span className="truncate">{e.label}</span>
              <b>{num(e.value)}</b>
            </span>
          ))}
        </p>
      )}
      {data.partial && (
        <p className={CAPTION}>
          The window has more rows than one page, so these are a lower bound.
        </p>
      )}
      <p className={FOOT}>
        Counted from the gateway’s own ledger, which survives a restart. Its Prometheus counters do
        not. A day that saw a failure is underlined in red.
      </p>
    </Board>
  )
}

export function ToolsModelsCalledBoard({ f }: { f: LitellmFacts }) {
  const { data, total } = f
  // A time column only while some tool has one: a column of dashes says
  // nothing a missing column does not.
  const timed = data.mcp.some((t) => t.latencyMs !== null && Number.isFinite(t.latencyMs))
  return (
    <Board
      title="Tools models called"
      icon="hash"
      span={4}
      aside={
        <span className={NOTE}>
          {data.mcpServers.length === 0
            ? `MCP, ${String(total.days)}d`
            : data.mcpServers.map((s) => `${s.name} ${String(s.calls)}`).join(' · ')}
        </span>
      }
    >
      {data.mcp.length === 0 ? (
        <p className={EMPTY}>no tool calls in the window</p>
      ) : (
        <ul className={ITEMS}>
          {data.mcp.map((t) => (
            <li key={`${t.server}/${t.tool}`} className={ITEM}>
              <span className="w-[4.5rem] flex-none truncate text-[0.75rem] text-muted-foreground">
                {t.server}
              </span>
              <span className={cn(ITEM_MAIN, MONO)} title={t.tool}>
                {t.tool}
              </span>
              {/* The tool's own time, which is the only latency on this
                  page that is NOT mostly the model server — a tool call is the
                  gateway talking to a container on this box, so tens of
                  milliseconds is what right looks like. */}
              {timed && <span className={ITEM_SIDE}>{ms(t.latencyMs)}</span>}
              <span className={ITEM_N}>{num(t.calls)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        The other direction: tools the gateway hands to a model mid-answer, counted when one was
        invoked. A registered server with no calls does not appear, and a tool whose counters were
        reset by a restart shows no time.
      </p>
    </Board>
  )
}

type NeighbourData = LitellmData['neighbours'][number]

/**
 * One of the gateway's neighbours, as a pair of boards.
 *
 * Changelog on the left, log on the right, side by side while the changelog is
 * short; stacked at full width once it runs past a handful of entries, where a
 * half-width pair left the log board standing in a panel twice its height and
 * truncated every commit title. Both, because those are the only two
 * things ever wanted from a container with no page of its own: what would
 * change if I updated it, and what has it been saying. The title carries the
 * verdict, so the row answers "is anything here behind" before it is read.
 */
export function NeighbourPair({ n }: { n: NeighbourData }) {
  const behind = n.gap?.behind.length ?? n.build?.behind.length ?? 0
  const unit =
    n.gap !== null ? (behind === 1 ? 'release behind' : 'releases behind') : 'commits behind'
  const count = String(behind)
  const span = behind > 6 ? 12 : 6

  return (
    <>
      <Changelog
        gap={n.gap}
        build={n.build}
        span={span}
        title={behind === 0 ? `${n.label} — current` : `${n.label} — ${count} ${unit}`}
        aside={
          <span className={NOTE}>
            {n.version === null ? 'version unknown' : <span className={MONO}>{n.version}</span>}
          </span>
        }
        foot={<p className={FOOT}>{n.note}</p>}
      />
      <Board
        title={`${n.label} logs`}
        icon="logs"
        span={span}
        aside={<span className={NOTE}>{n.role}</span>}
      >
        <GrafanaLogs source={{ container: n.container }} title={`${n.label} logs`} />
      </Board>
    </>
  )
}

/** `29 req · 28k tok`, or an em dash for a day the gateway served nothing. */
function volume(v: { requests: number; tokens: number } | null): string {
  if (v === null || v.requests === 0) return DASH
  return `${num(v.requests)} req · ${compact(v.tokens)} tok`
}
