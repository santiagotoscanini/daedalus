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
import { Topology, type TopoEdge, type TopoStage } from '../topology'
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
        title="How a prompt gets answered"
        icon="⇉"
        span={12}
        aside={
          <span className="board-note">
            {headline.inFlight !== null && headline.inFlight > 0 ?
              `${num(headline.inFlight)} in flight`
            : 'idle'}
          </span>
        }
      >
        <Topology
          stages={aiStages(data)}
          edges={aiEdges(data)}
          foot={
            <>
              Nothing here holds a model. Every caller speaks the OpenAI API to LiteLLM, which is
              the only thing that knows where the weights actually are — so swapping Lemonade for
              something else is a gateway config change and no caller notices.
            </>
          }
        />
      </Board>

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

/**
 * The path a prompt takes: caller → gateway → whatever actually holds weights.
 *
 * The client column is read from the gateway's own key ledger rather than
 * hardcoded, so a new API key shows up as a new box the first time it spends a
 * token. `byClient` labels are key aliases, which are already the names of the
 * things calling — n8n, open-webui, daedalus.
 */
function aiStages(data: AiData): TopoStage[] {
  const clients = data.byClient.slice(0, 4)
  const total = clients.reduce((n, c) => n + c.value, 0)
  const embeddings = data.byModel.find((m) => /embed/i.test(m.label))

  return [
    {
      id: 'callers',
      title: 'Callers',
      zone: 'this box',
      nodes:
        clients.length === 0 ?
          [{ id: 'noclients', label: 'No traffic', sub: 'nothing has spent a token', idle: true }]
        : clients.map((c) => ({
            id: `c-${c.label}`,
            label: c.label,
            sub: total === 0 ? undefined : `${((c.value / total) * 100).toFixed(0)}% of tokens`,
            icon: '◈',
            tone: 'info' as const,
            facts: [{ k: 'tokens', v: num(c.value) }],
          })),
    },
    {
      id: 'gateway',
      title: 'Gateway',
      zone: 'this box',
      nodes: [
        {
          id: 'litellm',
          label: 'LiteLLM',
          sub: 'OpenAI-compatible front door',
          icon: '⇄',
          tone: 'accent',
          live: data.headline.inFlight !== null && data.headline.inFlight > 0,
          facts: [
            { k: 'today', v: num(data.headline.requestsToday) },
            { k: 'in flight', v: num(data.headline.inFlight) },
          ],
        },
      ],
    },
    {
      id: 'backends',
      title: 'Backends',
      // Lemonade is the one thing on this page that is NOT on this box, and
      // that is the whole reason a cold first token is slow — it is a
      // different machine that may have swapped the model out.
      zone: 'elsewhere',
      nodes: [
        {
          id: 'lemonade',
          label: 'Lemonade',
          sub: 'gaming PC · llama.cpp',
          icon: '◆',
          tone: 'ok',
          live: data.lemonade.tps !== null && data.lemonade.tps > 0,
          facts: [
            { k: 'resident', v: num(data.headline.modelsResident) },
            { k: 'tok/s', v: num(data.lemonade.tps, 1) },
          ],
        },
        {
          id: 'searxng',
          label: 'SearXNG',
          sub: 'web search tool',
          icon: '◍',
          tone: 'info',
          idle: true,
        },
        {
          id: 'pgvector',
          label: 'pgvector',
          sub: 'RAG store, shared pg',
          icon: '◱',
          tone: 'info',
          idle: embeddings === undefined,
          facts:
            embeddings === undefined ? undefined : [{ k: 'embed tok', v: num(embeddings.value) }],
        },
      ],
    },
  ]
}

function aiEdges(data: AiData): TopoEdge[] {
  const clients = data.byClient.slice(0, 4)
  const busy = data.headline.inFlight !== null && data.headline.inFlight > 0
  const embeddings = data.byModel.find((m) => /embed/i.test(m.label))
  const chat = data.byModel.filter((m) => !/embed/i.test(m.label)).reduce((n, m) => n + m.value, 0)

  return [
    ...(clients.length === 0 ?
      [{ from: 'noclients', to: 'litellm', dashed: true }]
    : clients.map((c) => ({
        from: `c-${c.label}`,
        to: 'litellm',
        // The key's own name is on the box; the edge carries what it spent,
        // which is the thing that differs between two identical-looking arrows.
        label: `${num(c.value)} tok`,
        tone: 'info' as const,
        active: busy,
      }))),
    {
      from: 'litellm',
      to: 'lemonade',
      label: chat > 0 ? `${num(chat)} tok` : 'chat · STT · TTS',
      tone: 'accent',
      active: busy,
    },
    { from: 'litellm', to: 'searxng', label: 'web_search', tone: 'muted', dashed: true },
    {
      from: 'litellm',
      to: 'pgvector',
      label: embeddings === undefined ? 'vector store' : `${num(embeddings.value)} tok`,
      tone: 'info',
      dashed: embeddings === undefined,
    },
  ]
}
