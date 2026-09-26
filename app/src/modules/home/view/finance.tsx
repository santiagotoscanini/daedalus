import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import {
  compareOf,
  Open,
  ServiceHead,
  SOURCE_NOTE,
  verdictOf,
} from '../../../components/service-head'
import { FOOT, MONO } from '../../../components/tokens'
import { Board, BoardGrid, Chip, Facts } from '../../../components/viz'
import { DASH } from '../../../lib/format'
import type { HomeData } from '../data'

// Home › Finance: Wealthfolio — deliberately thin: its API wants a browser
// session, so the version, whether it is current, and the log are what can be
// said.

type Finance = Extract<HomeData, { tab: 'finance' }>

export function FinanceView({ data: d }: { data: Finance }) {
  return (
    <>
      <ServiceHead
        logo="/icon-wealthfolio.png"
        name="Wealthfolio"
        version={d.running.version}
        versionNote={SOURCE_NOTE[d.running.source]}
        verdict={verdictOf(d.gap)}
        compare={compareOf(
          d.gap,
          d.running.source === 'pin'
            ? 'the image tag — the app serves no version'
            : 'the image’s own OCI label',
        )}
        lede={
          <>
            Portfolio and personal finance, signed in through Pocket ID. Everything it holds is one
            person&rsquo;s, which is what puts it on this side of the rule.
          </>
        }
        actions={<Open name="Wealthfolio" host="wealthfolio" />}
      />

      <BoardGrid>
        <Board title="What this page can say" icon="◔" span={12}>
          <Facts
            rows={[
              { k: 'Running', v: d.running.version ?? DASH },
              {
                k: 'Built from',
                v:
                  d.running.revision === null ? (
                    DASH
                  ) : (
                    <span className={MONO}>{d.running.revision}</span>
                  ),
              },
              {
                k: 'Latest release',
                v:
                  d.gap.latest === null ? (
                    DASH
                  ) : d.gap.behind.length === 0 ? (
                    <Chip tone="ok">up to date</Chip>
                  ) : (
                    <Chip tone="warn">{d.gap.latest}</Chip>
                  ),
              },
            ]}
          />
          {/* Said out loud rather than left as an empty page. A panel that is
              blank because nothing was asked and one that is blank because
              the answer is zero look identical otherwise. */}
          <p className={FOOT}>
            Deliberately thin. Every path under this hostname returns the single-page app, and the
            API behind it authenticates with a browser session rather than a key, so there is no
            holding, no balance and no transaction count this dashboard can read without being a
            logged-in browser. What is left is real: the version, whether it is current, and the
            log. The alternative was the tile it replaces, which carried a name and a link and
            answered nothing at all.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard source={{ container: 'wealthfolio' }} title="Wealthfolio logs" />
      </BoardGrid>
    </>
  )
}
