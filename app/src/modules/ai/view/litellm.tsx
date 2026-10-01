import { GrafanaLogs } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { freshnessRow, LinkRow, ServiceHead, verdictOf } from '../../../components/service-head'
import { Button } from '../../../components/ui/button'
import { Board, BoardGrid, Chip } from '../../../components/viz'
import type { LitellmData } from '../data/litellm'
import {
  NeighbourPair,
  ToolsModelsCalledBoard,
  TrafficBoard,
  WhoIsCallingBoard,
} from './litellm-boards'
import { comparePinned, EMPTY, MONO } from './shared'

/**
 * The tab on a box with no gateway bound. Said once, in place of a page of
 * zeroes and dashes that would read as a quiet fortnight.
 */
function NotConfigured() {
  return (
    <BoardGrid>
      <Board title="LiteLLM" span={12} aside={<Chip tone="muted">not configured</Chip>}>
        <p className={EMPTY}>
          No gateway is bound to this box: <span className={MONO}>LITELLM_BASE_URL</span> and{' '}
          <span className={MONO}>LITELLM_API_KEY</span> are both unset. Bind them and this tab
          reports who asked for what.
        </p>
      </Board>
    </BoardGrid>
  )
}

// ── LiteLLM ────────────────────────────────────────────────────────────────

export function LitellmView({ data }: { data: LitellmData }) {
  if (!data.configured) return <NotConfigured />
  const f = litellmFacts({ data })
  const { gap } = f

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
          <Button asChild size="sm">
            <a href={`${data.url}/ui`} target="_blank" rel="noreferrer">
              Open the admin UI ↗
            </a>
          </Button>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://docs.litellm.ai/docs/simple_proxy' },
          { label: 'Model hub', href: `${data.url}/ui/model_hub_table` },
          { label: 'GitHub', href: 'https://github.com/BerriAI/litellm' },
        ]}
      />

      {/* No headline band. Today's requests and failures are a measure line
          inside the panel whose chart they describe, where they can be read
          AGAINST that chart instead of a screen away from it. */}
      <BoardGrid>
        <TrafficBoard f={f} />

        <ToolsModelsCalledBoard f={f} />

        {/* The one axis on this page worth a panel of this size (see `Caller`
            in ../data/litellm.ts): who is calling cannot be known from
            anywhere else.

            It also opens the second row rather than sharing the first, and that
            is a layout decision rather than an editorial one: it runs to about
            twice the height of the traffic panel, so the two are paired with
            boards of their own size — stretching makes a row share one bottom
            edge, but it cannot invent content to fill the taller one with. */}
        <WhoIsCallingBoard f={f} />

        <Changelog gap={gap} span={6} />

        <Board title="Logs" icon="logs" span={12}>
          <GrafanaLogs source={{ container: 'litellm' }} title="LiteLLM logs" />
        </Board>

        {/* The containers the gateway dials, each as a pair: what a re-pull
            would bring, and what it has been saying (`loadNeighbours`). */}
        {data.neighbours.map((n) => (
          <NeighbourPair key={n.container} n={n} />
        ))}
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function litellmFacts({ data }: { data: LitellmData }) {
  const { gap, daily, window: total } = data
  const busy = data.inFlight !== null && data.inFlight > 0
  const firstDate = daily[0]?.date ?? ''
  // The window's last day IS today, since the window ends at today — and it is
  // the reference every "2d ago" below is measured against, rather than the
  // browser's clock, which would not agree with the server's at midnight.
  const todayDate = daily[daily.length - 1]?.date ?? ''
  return { data, gap, daily, total, busy, firstDate, todayDate }
}

export type LitellmFacts = NonNullable<ReturnType<typeof litellmFacts>>
