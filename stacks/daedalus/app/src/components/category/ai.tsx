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
 * The path a prompt takes: caller → gateway → whatever holds the weights.
 *
 * The callers are NAMED rather than derived from the key ledger. The ledger is
 * still where the token counts come from, but a caller that has not spent a
 * token today is not absent from the system — it is idle, and a diagram that
 * drops it is telling you the wrong thing. Open WebUI in particular signs its
 * traffic with a key whose alias is not "open-webui", so a ledger-driven
 * column left the one service a person actually types into off the picture.
 *
 * Everything hanging under the gateway is a TOOL it can call mid-completion,
 * not a step on the way to an answer — hence the branch row.
 */
const CALLERS: { id: string; label: string; sub: string; icon: string; keys: RegExp; app?: string }[] = [
  {
    id: 'owu',
    label: 'Open WebUI',
    sub: 'the chat window',
    icon: '◍',
    keys: /open-?webui|owui|litellm_/i,
    app: 'chat',
  },
  { id: 'n8n', label: 'n8n', sub: 'scheduled workflows', icon: '⟳', keys: /n8n/i, app: 'n8n' },
  {
    id: 'hass',
    label: 'Home Assistant',
    sub: 'voice + conversation agent',
    icon: '⌂',
    keys: /home-?assistant|hass/i,
    app: 'homeassistant',
  },
  { id: 'plane', label: 'Plane', sub: 'project assistant', icon: '◰', keys: /plane/i, app: 'plane' },
  {
    id: 'daedalus',
    label: 'daedalus',
    sub: 'this page',
    icon: '▦',
    keys: /daedalus/i,
  },
]

export function aiStages(data: AiData): TopoStage[] {
  const total = data.byClient.reduce((n, c) => n + c.value, 0)
  const tokensFor = (re: RegExp) =>
    data.byClient.filter((c) => re.test(c.label)).reduce((n, c) => n + c.value, 0)
  const embeddings = data.byModel.find((m) => /embed/i.test(m.label))
  const busy = data.headline.inFlight !== null && data.headline.inFlight > 0

  return [
    {
      id: 'callers',
      title: 'Callers',
      zone: 'this box',
      nodes: CALLERS.map((c) => {
        const spent = tokensFor(c.keys)
        return {
          id: c.id,
          label: c.label,
          sub: c.sub,
          icon: c.icon,
          tone: 'info' as const,
          idle: spent === 0,
          href: c.app === undefined ? undefined : `https://${c.app}.toscanini.me`,
          facts: [
            { k: 'tokens', v: num(spent) },
            { k: 'share', v: total === 0 ? DASH : `${((spent / total) * 100).toFixed(0)}%` },
          ],
        }
      }),
      // Open WebUI reaches SearXNG directly for its own RAG rather than
      // through the gateway — its search emits no web_search tool call, so
      // the gateway's interception never sees it.
      aside: [
        {
          label: 'Open WebUI · its own RAG',
          tone: 'info',
          node: {
            id: 'owu-search',
            label: 'SearXNG',
            sub: 'in-chat web search',
            icon: '◎',
            tone: 'info',
          },
        },
      ],
    },
    {
      id: 'gateway',
      title: 'Gateway',
      zone: 'this box',
      nodes: [
        {
          id: 'litellm',
          label: 'LiteLLM',
          sub: 'one OpenAI API for everything',
          icon: '⇄',
          tone: 'accent',
          href: 'https://litellm.toscanini.me/ui',
          live: busy,
          facts: [
            { k: 'today', v: num(data.headline.requestsToday) },
            { k: 'in flight', v: num(data.headline.inFlight) },
          ],
        },
      ],
      aside: [
        {
          label: 'tools it can call mid-completion',
          tone: 'accent',
          node: {
            id: 'mcp',
            label: 'MCP servers',
            sub: 'TickTick · Grocy',
            icon: '⚿',
            tone: 'accent',
          },
        },
        {
          label: 'retrieval',
          tone: 'info',
          node: {
            id: 'pgvector',
            label: 'pgvector',
            sub: 'vector store on the shared pg',
            icon: '◱',
            tone: 'info',
            idle: embeddings === undefined,
            facts:
              embeddings === undefined ? undefined : [{ k: 'embed tok', v: num(embeddings.value) }],
          },
        },
      ],
    },
    {
      id: 'models',
      title: 'Model server',
      // The one thing on this page that is not on this box, which is exactly
      // why a cold first token is slow.
      zone: 'the gaming PC',
      nodes: [
        {
          id: 'lemonade',
          label: 'Lemonade',
          sub: 'llama.cpp · chat, embeddings, STT, TTS',
          icon: '◆',
          tone: 'ok',
          live: data.lemonade.tps !== null && data.lemonade.tps > 0,
          facts: [
            { k: 'resident', v: num(data.headline.modelsResident) },
            { k: 'tok/s', v: num(data.lemonade.tps, 1) },
            { k: 'TTFT', v: data.lemonade.ttftMs === null ? DASH : `${num(data.lemonade.ttftMs)}ms` },
          ],
        },
      ],
      aside: [
        {
          label: 'hot right now',
          tone: 'ok',
          node: {
            id: 'hot',
            label: data.models.find((m) => m.hot)?.name ?? 'nothing loaded',
            sub: data.models.length === 0 ? 'Lemonade did not answer' : 'most recently used',
            icon: '▤',
            tone: 'ok',
            idle: data.models.length === 0,
          },
        },
      ],
    },
  ]
}

export function aiEdges(data: AiData): TopoEdge[] {
  const busy = data.headline.inFlight !== null && data.headline.inFlight > 0
  const tokensFor = (re: RegExp) =>
    data.byClient.filter((c) => re.test(c.label)).reduce((n, c) => n + c.value, 0)
  const chat = data.byModel.filter((m) => !/embed/i.test(m.label)).reduce((n, m) => n + m.value, 0)

  return [
    ...CALLERS.map((c) => {
      const spent = tokensFor(c.keys)
      return {
        from: c.id,
        to: 'litellm',
        label: spent === 0 ? 'idle' : `${num(spent)} tok`,
        tone: 'info' as const,
        active: busy && spent > 0,
        dashed: spent === 0,
      }
    }),
    {
      from: 'litellm',
      to: 'lemonade',
      label: chat > 0 ? `${num(chat)} tok` : 'OpenAI API',
      tone: 'accent',
      active: busy,
    },
  ]
}
