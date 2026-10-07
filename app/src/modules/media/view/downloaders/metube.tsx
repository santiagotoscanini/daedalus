import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../../components/service-head'
import { BoardGrid, Stat, StatStrip } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { num } from '../../../../lib/format'
import {
  CELL_QUIET,
  FOOT,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableSection,
} from '../shared'
import type { Downloaders } from './shared'

/* Status, then title. The status column is narrow and quiet: its vocabulary
   is small and nearly always the same word. */
const RECENT_GRID = 'grid grid-cols-[7rem_minmax(0,1fr)] items-center gap-x-6 px-5'

export function MetubePage({ d }: { d: Downloaders['metube'] }) {
  return (
    <>
      <ServiceHead
        logo="/icon-metube.svg"
        name="MeTube"
        version={d.version}
        versionNote="from the tag the flake pins"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'the image tag, since MeTube serves no version')}
        lede={
          <>
            yt-dlp with a web form in front of it, and the only downloader here that nothing else
            drives: you point it at a URL yourself. Also inside the VPN namespace, which is
            occasionally why a site refuses it.
          </>
        }
        actions={<Open name="MeTube" host="metube" />}
      />

      {/* Three counts read across: a strip, not a board beside a list that
          repeated two of them in its header. */}
      <StatStrip>
        <Stat label="Completed, all time" value={num(d.done)} />
        <Stat label="Queued" value={num(d.queued)} />
        <Stat label="Pending" value={num(d.pending)} />
      </StatStrip>

      <BoardGrid>
        <TableSection
          title="Recent"
          foot={
            <p className={FOOT}>
              The most recent finished items. MeTube keeps its history in the browser session as
              well as on the server, so this list and the one in its own UI can differ.
            </p>
          }
        >
          <ul className={TABLE} aria-label="MeTube, recent">
            {d.recent.length > 0 && (
              <li aria-hidden="true" className={cn(RECENT_GRID, TABLE_HEAD)}>
                <span>Status</span>
                <span>Title</span>
              </li>
            )}
            {d.recent.length === 0 ? (
              <li className={TABLE_EMPTY}>Nothing downloaded yet.</li>
            ) : (
              d.recent.map((r, i) => (
                <li key={`${r.title}-${String(i)}`} className={cn(RECENT_GRID, TABLE_ROW)}>
                  {/* Finished is every row on a good day: quiet. Anything else
                      is the row to read. */}
                  <span
                    className={cn(
                      CELL_QUIET,
                      'first-letter:uppercase',
                      r.status !== 'finished' && 'text-danger',
                    )}
                  >
                    {r.status}
                  </span>
                  <span className="truncate text-foreground" title={r.title}>
                    {r.title}
                  </span>
                </li>
              ))
            )}
          </ul>
        </TableSection>

        <Changelog
          gap={d.gap}
          span={12}
          foot={
            <p className={FOOT}>
              MeTube ships a new dated build most weeks and almost all of them are a yt-dlp bump,
              which is what fixes a site that suddenly stopped downloading. It is the one service on
              this page where being behind is usually the whole explanation.
            </p>
          }
        />

        <LogBoard source={{ container: 'metube' }} title="MeTube logs" />
      </BoardGrid>
    </>
  )
}
