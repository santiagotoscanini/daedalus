import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import {
  compareOf,
  Open,
  ServiceHead,
  SOURCE_NOTE,
  verdictOf,
} from '../../../../components/service-head'
import { BoardGrid, Chip, Stat, StatStrip } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { num } from '../../../../lib/format'
import { CAPTION, FOOT, MONO, NOTE, QueueTable, TableSection, VERSION_SNAPSHOT } from '../shared'
import type { Downloaders } from './shared'

export function ShelfmarkPage({ d }: { d: Downloaders }) {
  const { shelfmark } = d
  const counts = shelfmark.counts

  return (
    <>
      <ServiceHead
        logo="/icon-shelfmark.png"
        name="Shelfmark"
        version={shelfmark.running.version}
        versionNote={SOURCE_NOTE[shelfmark.running.source]}
        verdict={verdictOf(shelfmark.gap)}
        compare={compareOf(
          shelfmark.gap,
          // The pin is `:latest` by digest, so the tag names a channel and this
          // number comes from org.opencontainers.image.version in the image.
          shelfmark.running.revision === null
            ? 'the image’s OCI label'
            : `the image’s OCI label, built from ${shelfmark.running.revision}`,
        )}
        lede={
          <>
            The half that goes and gets things: searches Anna&rsquo;s Archive through the downloads
            stack&rsquo;s VPN and drops finished files where Calibre-Web ingests them. A book that
            never appeared usually failed here, not on the shelf.
          </>
        }
        actions={<Open name="Shelfmark" host="shelfmark" />}
      />

      {/* The queue's counts, read across. The jobs table under them used to
          repeat two of these in its header. */}
      {counts === null ? (
        <p className={cn(CAPTION, 'mb-4')}>The queue did not answer: no reading.</p>
      ) : (
        <StatStrip>
          <Stat label="Downloading" value={num(counts.downloading)} />
          <Stat label="Queued" value={num(counts.queued)} />
          <Stat label="Completed" value={num(counts.done)} />
          <Stat
            label="Errors"
            value={num(counts.errors)}
            tone={counts.errors > 0 ? 'warn' : undefined}
          />
        </StatStrip>
      )}

      <BoardGrid>
        <TableSection title="Downloading">
          <QueueTable
            label="Shelfmark jobs"
            detail="State"
            empty="Queue is empty."
            rows={shelfmark.jobs.map((j, i) => ({
              key: `${j.title}-${String(i)}`,
              name: j.title,
              pct: j.pct,
              tone: j.state === 'error' ? 'bad' : 'muted',
              active: j.state === 'downloading',
              // An error is the state to read; the rest are the machine working.
              detail:
                j.state === 'error' ? <Chip tone="bad">{j.state}</Chip> : <span>{j.state}</span>,
            }))}
          />
        </TableSection>

        <Changelog
          gap={shelfmark.gap}
          span={12}
          aside={
            shelfmark.running.revision === null ? (
              <span className={NOTE}>calibrain/shelfmark</span>
            ) : (
              <span className={cn(NOTE, MONO)}>{shelfmark.running.revision}</span>
            )
          }
          foot={
            <p className={FOOT}>
              The pin is a moving <span className={MONO}>:latest</span> by digest, so the tag says
              nothing. The image does: its OCI labels carry the version and the commit it was built
              from, which is what makes this a real gap rather than a list of everything that has
              ever shipped.
            </p>
          }
        />

        <LogBoard
          source={{ container: 'shelfmark' }}
          title="Shelfmark logs"
          neighbours={[VERSION_SNAPSHOT]}
        />
      </BoardGrid>
    </>
  )
}
