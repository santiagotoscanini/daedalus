import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { FOOT } from '../../../components/tokens'
import { Board, BoardGrid, Chip, Facts } from '../../../components/viz'
import { DASH } from '../../../lib/format'
import type { HomeData } from '../data'

// Home › Tools: Stirling-PDF — stateless, so a status, a version and a log.

type Tools = Extract<HomeData, { tab: 'tools' }>

export function ToolsView({ data: d }: { data: Tools }) {
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
        actions={<Open name="Stirling-PDF" host="stirling-pdf" />}
      />

      <BoardGrid>
        <Board title="Status" icon="◔" span={12}>
          <Facts
            rows={[
              {
                k: 'Health',
                v:
                  d.status === null ? (
                    DASH
                  ) : d.status === 'UP' ? (
                    <Chip tone="ok">up</Chip>
                  ) : (
                    <Chip tone="warn">{d.status.toLowerCase()}</Chip>
                  ),
              },
              { k: 'Version', v: d.version ?? DASH },
              {
                k: 'Latest release',
                v:
                  d.gap.latest === null ? (
                    DASH
                  ) : d.gap.behind.length === 0 ? (
                    <Chip tone="ok">up to date</Chip>
                  ) : (
                    <Chip tone="warn">{d.gap.latest} available</Chip>
                  ),
              },
            ]}
          />
          <p className={FOOT}>
            Stateless: documents are processed in memory and dropped, which is why this tab is a
            version and a log and stops there. It is also why this is the one application here that
            could be deleted and rebuilt from nothing with no loss.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard source={{ container: 'stirling-pdf' }} title="Stirling-PDF logs" />
      </BoardGrid>
    </>
  )
}
