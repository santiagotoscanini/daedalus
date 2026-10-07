import { LogBoard } from '../../../components/logs'
import { QuietState } from '../../../components/modules/parts'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { FOOT, NOTE } from '../../../components/tokens'
import { BoardGrid, Chip } from '../../../components/viz'
import type { HomeData } from '../data'

// Home › Tools: Stirling-PDF — stateless, so a status, a version and a log.
//
// The status is one word, so it sits in the header beside the link rather
// than in a board of its own: a two-fact board beside a five-release changelog
// was a short panel standing next to a tall one.

type Tools = Extract<HomeData, { tab: 'tools' }>

export function ToolsView({ data: d }: { data: Tools }) {
  const behind = d.gap.behind.length
  return (
    <>
      <ServiceHead
        logo="/icon-stirling-pdf.svg"
        name="Stirling-PDF"
        version={d.version}
        versionNote="reported by its status endpoint"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/v1/info/status')}
        lede={
          <>
            Split, merge, rotate, OCR, sign. A toolbox rather than a service: nothing is stored, so
            there is nothing here to back up.
          </>
        }
        actions={
          <>
            {d.status === null ? (
              <span className={NOTE}>health unknown</span>
            ) : d.status === 'UP' ? (
              <QuietState>up</QuietState>
            ) : (
              <Chip tone="warn">{d.status.toLowerCase()}</Chip>
            )}
            <Open name="Stirling-PDF" host="stirling-pdf" />
          </>
        }
      />

      <BoardGrid>
        <Changelog
          gap={d.gap}
          span={12}
          aside={
            d.gap.latest === null ? (
              <span className={NOTE}>github</span>
            ) : behind === 0 ? (
              <QuietState>up to date</QuietState>
            ) : (
              <Chip tone="warn">{d.gap.latest} available</Chip>
            )
          }
          foot={
            <>
              <p className={FOOT}>
                {behind === 0
                  ? 'What the running version shipped. Parsed from the project’s own GitHub releases and shortened; open one for the detail.'
                  : 'Everything between the running version and the newest release, oldest at the top. Parsed from the project’s own GitHub releases and shortened; open one for the detail, and the link inside goes to the full text.'}
              </p>
              <p className={FOOT}>
                Stateless: documents are processed in memory and dropped, which is why this tab is a
                version and a log and stops there. It is also why this is the one application here
                that could be deleted and rebuilt from nothing with no loss.
              </p>
            </>
          }
        />

        <LogBoard source={{ container: 'stirling-pdf' }} title="Stirling-PDF logs" />
      </BoardGrid>
    </>
  )
}
