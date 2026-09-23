import { Link, useSearch } from '@tanstack/react-router'
import { HeadStrip, OS_MARK, WipBoard } from '../../../components/machine-system/shared'
import { FOOT, LIST, MONO, NOTE, ROW, ROW_MAIN, ROW_SIDE } from '../../../components/tokens'
import { Board, BoardGrid, Chip, Measures, Pulse } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, num } from '../../../lib/format'
import type { Tone } from '../../../lib/tone'
import type { ProviderMachine } from '../data'
import type { Chain, ProvidersData } from '../data/providers'

/** A model's mode, as the page says it. */
const MODE_WORD: Record<ProviderMachine['models'][number]['mode'], string> = {
  chat: 'chat',
  embedding: 'embeddings',
  rerank: 'reranking',
  audio_transcription: 'speech to text',
  audio_speech: 'text to speech',
  image_generation: 'images',
  image_edit: 'image edit',
}

// The Providers tab: the chain once, then the picked machine.
//
// The picker is inside the tab rather than above the row — this is the
// one tab whose subject is several machines, and the other two tabs are
// services on this box. Every machine's reading is in the payload, so a
// pick is a re-render; the URL carries it so a refresh and a link keep it.

const BOX_MARK = { src: '/icon-nixos.webp', invert: false }

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

function MachinePills({ machines, active }: { machines: ProviderMachine[]; active: string }) {
  const pill = (selected: boolean) =>
    cn(
      'inline-flex items-center gap-2 rounded-full border px-3 py-1 text-[0.8rem] transition-colors',
      selected
        ? 'border-primary bg-primary/10 text-foreground'
        : 'border-border text-muted-foreground hover:bg-accent hover:text-foreground',
    )
  return (
    <nav aria-label="Provider machine" className="mb-4 flex flex-wrap items-center gap-2">
      {machines.map((m) => {
        const mark = m.machine === 'box' ? BOX_MARK : OS_MARK[m.os]
        return (
          <Link
            key={m.machine}
            to="/c/$category"
            params={{ category: 'ai' }}
            search={{ tab: 'providers', machine: m.machine }}
            className={pill(active === m.machine)}
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
            <Pulse on={m.reachable} tone={m.reachable ? 'ok' : 'muted'} />
          </Link>
        )
      })}
    </nav>
  )
}

const modeTone = (mode: ProviderMachine['models'][number]['mode']): Tone =>
  mode === 'chat' ? 'accent' : mode === 'embedding' || mode === 'rerank' ? 'info' : 'muted'

function MachineView({ m }: { m: ProviderMachine }) {
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
  const catalog = m.models
  const routed = catalog.filter((x) => x.routed !== null).length

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

      <BoardGrid>
        <Board
          title="Loaded now"
          icon="rows"
          span={8}
          aside={<span className={NOTE}>what is resident at the provider</span>}
        >
          {m.loaded.length === 0 ? (
            <p className={FOOT}>
              {m.reachable
                ? 'Nothing is loaded; the first call loads a model.'
                : 'Unknown until it answers.'}
            </p>
          ) : (
            <ul className={LIST}>
              {m.loaded.map((l) => (
                <li key={l.id} className={ROW}>
                  <Pulse on tone="ok" />
                  <span className={ROW_MAIN}>
                    <b className="font-[550]">{l.id}</b>
                  </span>
                  <span className={ROW_SIDE}>
                    {l.device ?? DASH}
                    {l.maxContext !== null && ` · ${num(l.maxContext)} ctx`}
                    {l.pinned && ' · pinned'}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Board>

        <Board title="Offered" icon="grid" span={4}>
          <Measures
            items={[
              { k: 'in the catalog', v: num(catalog.length) },
              { k: 'on disk', v: num(catalog.filter((x) => x.downloaded).length) },
              {
                k: 'offered to the gateway',
                v: num(m.offerableCount),
                tone: m.offerableCount > 0 ? 'ok' : 'muted',
              },
              { k: 'routed today', v: num(routed) },
            ]}
          />
          <p className={FOOT}>
            {m.offered
              ? 'Every model on disk here is offered; the gateway sync writes a route per model and removes it when the model leaves.'
              : m.machine === 'box'
                ? 'Speech to text, served by the box itself rather than by a node. Offer it on Settings › Machines to publish it through the gateway.'
                : 'Switch "offer to the gateway" on Settings › Machines to publish these.'}
          </p>
        </Board>

        <Board
          title="Catalog"
          icon="logs"
          span={12}
          aside={<span className={NOTE}>as the provider lists it</span>}
        >
          {catalog.length === 0 ? (
            <p className={FOOT}>
              {m.reachable ? 'The provider lists no models.' : 'Unknown until it answers.'}
            </p>
          ) : (
            <ul className={LIST}>
              {catalog.map((x) => (
                <li key={x.id} className={ROW}>
                  <Chip tone={modeTone(x.mode)}>{MODE_WORD[x.mode]}</Chip>
                  <span className={ROW_MAIN}>
                    <b className="font-[550]">{x.id}</b>
                    <span className={`ml-[0.4rem] ${MONO} text-muted-foreground`}>
                      {x.routed ?? x.alias}
                    </span>
                    {x.labels
                      .filter((l) => !['custom', 'llamacpp'].includes(l))
                      .map((l) => (
                        <span
                          key={l}
                          className="ml-[0.3rem] rounded border border-(--border-soft) px-[0.3rem] py-[0.05rem] text-[0.66rem] text-muted-foreground"
                        >
                          {l}
                        </span>
                      ))}
                  </span>
                  <span className={ROW_SIDE}>
                    {x.sizeGb !== null && `${num(x.sizeGb, 1)} GB · `}
                    {x.recipe !== null && `${x.recipe} · `}
                    {!x.downloaded ? (
                      'not on disk'
                    ) : x.routed !== null ? (
                      <span className="text-(--tone-ok)">routed as {x.routed}</span>
                    ) : x.offerable ? (
                      'offered, awaiting the sync'
                    ) : (
                      'not offered'
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Board>

        <WipBoard title="GPU right now" span={6} waits="waits on the agent’s GPU live figures">
          <Measures
            items={[
              { k: 'load', v: '41%' },
              { k: 'memory', v: '13.2 of 24 GB' },
              { k: 'die', v: '61 °C' },
              { k: 'clock', v: '2,410 MHz' },
            ]}
          />
        </WipBoard>

        <WipBoard
          title="Last generation"
          span={6}
          waits="waits on per-model counters from the provider; the routes themselves are the sync’s now"
        >
          <Measures
            items={[
              { k: 'tokens per second', v: '38.4' },
              { k: 'first token', v: '412 ms' },
              { k: 'requests today', v: '27' },
              { k: 'output tokens today', v: '18,930' },
            ]}
          />
        </WipBoard>
      </BoardGrid>
    </>
  )
}

export function ProvidersView({ data }: { data: ProvidersData }) {
  const search = useSearch({ from: '/c/$category' })
  const wanted = search.machine ?? data.defaultMachine
  const active = data.machines.find((m) => m.machine === wanted) ?? data.machines[0]

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
          <MachinePills machines={data.machines} active={active?.machine ?? ''} />
          {active !== undefined && <MachineView m={active} />}
        </>
      )}
    </>
  )
}
