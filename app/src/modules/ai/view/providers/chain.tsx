import { Link } from '@tanstack/react-router'
import { ChevronRightIcon } from 'lucide-react'
import { CAPTION, FOOT, NOTE } from '../../../../components/tokens'
import { Board, BoardGrid } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { num } from '../../../../lib/format'
import type { Chain } from '../../data/providers'

/* ── the chain ────────────────────────────────────────────────────────── */

/* Three readings on one surface, divided by hairlines rather than drawn as
   three boxes inside a box. The chevron sitting on each divider is the only
   ornament, and it says the one thing a hairline cannot: which way a request
   travels. Stacked under 40rem, where the dividers go. */
const STEPS = 'grid grid-cols-3 @max-[40rem]/board:grid-cols-1 @max-[40rem]/board:gap-y-5'
const STEP =
  'relative flex min-w-0 flex-col gap-1 px-6 first:pl-0 last:pr-0 not-first:border-l not-first:border-hairline @max-[40rem]/board:border-l-0 @max-[40rem]/board:px-0'
const ARROW =
  'absolute top-1/2 -left-[0.6875rem] size-[1.375rem] -translate-y-1/2 rounded-full border border-hairline bg-popover p-[0.2rem] text-muted-foreground @max-[40rem]/board:hidden'
const FIGURE =
  'm-0 text-[1.6rem] leading-[1.15] tracking-tight tabular-nums text-foreground [font-weight:560]'
/* The step's name, which for the two other tabs is the way to them. */
const STEP_LINK = 'text-inherit no-underline hover:text-foreground hover:no-underline'

type Step = {
  title: string
  /** The tab that says more, when it is not this one. */
  tab?: 'gateway' | 'consumers'
  big: string
  /** The step's readings (counts, an error), not prose: always visible. */
  lines: string[]
}

function StepCell({ step, first }: { step: Step; first: boolean }) {
  return (
    <div className={STEP}>
      {!first && <ChevronRightIcon aria-hidden className={ARROW} strokeWidth={1.75} />}
      <p className={cn(NOTE, 'm-0')}>
        {step.tab === undefined ? (
          step.title
        ) : (
          <Link
            to="/c/$category"
            params={{ category: 'ai' }}
            search={{ tab: step.tab }}
            className={STEP_LINK}
          >
            {step.title} ›
          </Link>
        )}
      </p>
      <p className={FIGURE}>{step.big}</p>
      {step.lines.map((l) => (
        <p key={l} className={cn(CAPTION, 'm-0')}>
          {l}
        </p>
      ))}
    </div>
  )
}

export function ChainBoard({ chain }: { chain: Chain }) {
  const g = chain.gateway
  const steps: Step[] = [
    {
      title: 'Providers',
      big: `${num(chain.providers.machines)} ${chain.providers.machines === 1 ? 'machine' : 'machines'}`,
      lines: [
        `${num(chain.providers.reachable)} answering · ${num(chain.providers.offerable)} models offered`,
      ],
    },
    {
      title: 'Gateway',
      tab: 'gateway',
      big: g.configured ? `${num(g.routes)} routes` : 'none',
      lines: g.configured
        ? [
            `${num(g.synced)} written by daedalus · ${num(g.fromConfig)} from config.yaml`,
            ...(g.error === null ? [] : [g.error]),
          ]
        : ['no LiteLLM bound to this box'],
    },
    {
      title: 'Consumers',
      tab: 'consumers',
      big: `${num(chain.consumers.length)} ${chain.consumers.length === 1 ? 'caller' : 'callers'}`,
      lines: [chain.consumers.map((c) => c.name).join(', ') || 'nothing calls it yet'],
    },
  ]
  return (
    <BoardGrid>
      <Board title="The chain" icon="grid" span={12}>
        <div className={STEPS}>
          {steps.map((s, i) => (
            <StepCell key={s.title} step={s} first={i === 0} />
          ))}
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
