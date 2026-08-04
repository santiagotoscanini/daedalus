import {
  BarList,
  Board,
  BoardGrid,
  BigStat,
  Chip,
  Columns,
  Facts,
  Pulse,
  StatBand,
} from '../viz'
import { DASH, num } from '../../lib/dashboard/format'
import type { AiData } from '../../server/category'

// The AI page.
//
// Reads top-down as: how much did the gateway do, what is loaded to do it
// with, who asked, and did the automations that use it run. The Lemonade
// panel is deliberately the second thing on the page — six models sit resident
// on the gaming PC at once and which one is actually warm is the single fact
// that explains a slow first token.

export function AiView({ data }: { data: AiData }) {
  const { headline, lemonade, openWebUI } = data

  return (
    <>
      <StatBand>
        <BigStat
          label="Requests today"
          value={num(headline.requestsToday)}
          spark={headline.requestsSpark}
          sub={`${num(data.daily.reduce((a, d) => a + d.requests, 0))} in ${String(data.daily.length)}d`}
        />
        <BigStat
          label="Tokens today"
          value={num(headline.tokensToday)}
          tone="info"
          sub={`${num(data.daily.reduce((a, d) => a + d.tokens, 0))} in ${String(data.daily.length)}d`}
        />
        <BigStat
          label="Models resident"
          value={num(headline.modelsResident)}
          tone="ok"
          sub="on the gaming PC"
        />
        <BigStat
          label="In flight"
          value={num(headline.inFlight)}
          tone={headline.inFlight !== null && headline.inFlight > 0 ? 'accent' : 'muted'}
          sub={
            <>
              <Pulse on={headline.inFlight !== null && headline.inFlight > 0} tone="accent" />
              through the gateway
            </>
          }
        />
      </StatBand>

      <BoardGrid>
        <Board
          title="Gateway traffic"
          icon="◇"
          span={8}
          aside={<span className="board-note">requests per day, {data.daily.length} days</span>}
        >
          <Columns
            points={data.daily.map((d) => ({
              // Month-day only: the year is the same for every column and the
              // axis is narrow.
              label: d.date.slice(5),
              value: d.requests,
              display: `${num(d.requests)} requests · ${num(d.tokens)} tokens`,
            }))}
          />
          <Facts
            rows={[
              {
                k: 'Failed',
                v: num(data.daily.reduce((a, d) => a + d.failed, 0)),
              },
              { k: 'Busiest day', v: busiest(data.daily) },
              { k: 'Open WebUI', v: openWebUI.version ?? DASH },
              {
                k: 'Update',
                v:
                  openWebUI.latest === null || openWebUI.latest === openWebUI.version ?
                    'up to date'
                  : `${openWebUI.latest} available`,
              },
            ]}
          />
        </Board>

        <Board title="Last generation" icon="⚡" span={4}>
          <div className="metric-pair">
            <BigStat
              label="Throughput"
              value={lemonade.tps === null ? DASH : lemonade.tps.toFixed(1)}
              unit="tok/s"
            />
            <BigStat
              label="First token"
              value={lemonade.ttftMs === null ? DASH : num(lemonade.ttftMs)}
              unit="ms"
              tone="info"
            />
          </div>
          <Facts
            rows={[
              { k: 'Requests served', v: num(lemonade.requests) },
              { k: 'Tokens in', v: num(lemonade.inputTokens) },
              { k: 'Tokens out', v: num(lemonade.outputTokens) },
            ]}
          />
        </Board>

        <Board
          title="Model rack"
          icon="▤"
          span={6}
          aside={<span className="board-note">resident on Lemonade</span>}
        >
          {data.models.length === 0 ?
            <p className="viz-empty">Lemonade did not answer</p>
          : <ul className="rack">
              {data.models.map((m) => (
                <li key={m.name} className={m.hot ? 'rack-row rack-hot' : 'rack-row'}>
                  <span className="rack-name" title={m.name}>
                    {m.hot && <Pulse on tone="accent" />}
                    {m.name}
                  </span>
                  <span className="rack-tags">
                    <Chip tone={m.device === 'gpu' ? 'ok' : 'muted'}>{m.device}</Chip>
                    <Chip tone="info">{m.type}</Chip>
                    {m.pinned && <Chip>pinned</Chip>}
                    {m.context !== null && <Chip>{num(m.context / 1024)}k ctx</Chip>}
                  </span>
                </li>
              ))}
            </ul>
          }
          {/* `last_use` is a monotonic counter on Lemonade's side, so it can
              order this list but cannot date it — saying "4 min ago" would be
              inventing a wall clock the source does not have. */}
          <p className="board-foot">Most recently used first. Lemonade reports order, not times.</p>
        </Board>

        <Board title="Where the tokens went" icon="◑" span={6}>
          <BarList
            items={data.byModel.map((m) => ({
              label: m.label,
              value: m.value,
              display: num(m.value),
            }))}
            empty="no traffic in the window"
          />
          <h4 className="board-sub">By client</h4>
          <BarList
            items={data.byClient.map((c) => ({
              label: c.label,
              value: c.value,
              display: num(c.value),
            }))}
            tone="info"
            empty="no keyed traffic in the window"
          />
        </Board>

        <Board title="Automations" icon="⟳" span={6}>
          {data.n8n.length === 0 ?
            <p className="viz-empty">{data.n8nNote ?? 'no recent executions'}</p>
          : <ul className="runs">
              {data.n8n.map((r, i) => (
                <li key={`${r.name}-${String(i)}`} className={`runs-row runs-${statusTone(r.status)}`}>
                  <span className="runs-name">{r.name}</span>
                  <span className="runs-status">{r.status}</span>
                  <span className="runs-when">{r.ago}</span>
                </li>
              ))}
            </ul>
          }
          {data.n8n.length > 0 && data.n8nNote !== null && (
            <p className="board-foot">{data.n8nNote}</p>
          )}
        </Board>

        <Board title="Chat" icon="◍" span={6}>
          <Facts
            rows={[
              { k: 'Active users (3 min)', v: num(openWebUI.users) },
              { k: 'Generating now', v: num(openWebUI.generating) },
              { k: 'Version', v: openWebUI.version ?? DASH },
              { k: 'Latest release', v: openWebUI.latest ?? DASH },
            ]}
          />
        </Board>
      </BoardGrid>
    </>
  )
}

function busiest(daily: AiData['daily']): string {
  const top = [...daily].sort((a, b) => b.requests - a.requests)[0]
  if (top === undefined || top.requests === 0) return DASH
  return `${top.date.slice(5)} · ${num(top.requests)}`
}

function statusTone(status: string): string {
  if (status === 'success') return 'ok'
  if (status === 'running' || status === 'waiting' || status === 'new') return 'live'
  return 'bad'
}
