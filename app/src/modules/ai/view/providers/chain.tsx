import { ChevronRightIcon } from 'lucide-react'
import { CAPTION, FOOT, NOTE } from '../../../../components/tokens'
import { Board, BoardGrid } from '../../../../components/viz'
import { num } from '../../../../lib/format'
import type { Chain } from '../../data/providers'

/* ── the chain ────────────────────────────────────────────────────────── */

/* Three inner tiles on the board's surface: a step lighter than the board,
   a hairline edge, the inner-tile radius. The chevron between them is the
   only ornament, and it is quiet on purpose. */
const TILE =
  'flex min-w-0 flex-1 flex-col gap-1 rounded-xl border border-hairline bg-foreground/[0.03] px-4 py-3'
const FIGURE =
  'm-0 text-[1.6rem] leading-[1.15] tracking-tight tabular-nums text-foreground [font-weight:560]'

export function ChainBoard({ chain }: { chain: Chain }) {
  const cell = (title: string, big: string, lines: string[]) => (
    <div className={TILE}>
      <p className={`${NOTE} m-0`}>{title}</p>
      <p className={FIGURE}>{big}</p>
      {/* The lines are the tile's readings (counts, an error), not prose: visible. */}
      {lines.map((l) => (
        <p key={l} className={`${CAPTION} m-0`}>
          {l}
        </p>
      ))}
    </div>
  )
  const arrow = (
    <ChevronRightIcon
      aria-hidden
      className="size-4 flex-none self-center text-muted-foreground/60 max-[44rem]:rotate-90"
    />
  )
  const g = chain.gateway
  return (
    <BoardGrid>
      <Board title="The chain" icon="grid" span={12}>
        <div className="flex items-stretch gap-3 max-[44rem]:flex-col">
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
