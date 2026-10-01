import { FOOT, NOTE } from '../../../../components/tokens'
import { Board, BoardGrid } from '../../../../components/viz'
import { num } from '../../../../lib/format'
import type { Chain } from '../../data/providers'

/* ── the chain ────────────────────────────────────────────────────────── */

export function ChainBoard({ chain }: { chain: Chain }) {
  const cell = (title: string, big: string, lines: string[]) => (
    <div className="min-w-0 flex-1 rounded-md border border-subtle px-3 py-2">
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
    <span aria-hidden className="flex-none self-center text-[1.1rem] text-muted-foreground">
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
