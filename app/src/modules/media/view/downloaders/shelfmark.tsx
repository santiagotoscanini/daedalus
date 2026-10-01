import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import {
  compareOf,
  Open,
  ServiceHead,
  SOURCE_NOTE,
  verdictOf,
} from '../../../../components/service-head'
import { Board, BoardGrid, Chip, Measures, Progress } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { num } from '../../../../lib/format'
import {
  EMPTY,
  FOOT,
  MONO,
  NOTE,
  TRANSFER_HEAD,
  TRANSFER_META,
  TRANSFER_NAME,
  TRANSFER_ROW,
  TRANSFERS,
  VERSION_SNAPSHOT,
} from '../shared'
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

      <BoardGrid>
        <Board
          title="Downloading"
          icon="down"
          span={8}
          aside={
            counts === null ? (
              <span className={NOTE}>did not answer</span>
            ) : (
              <span className={NOTE}>
                {num(counts.done)} completed · {num(counts.errors)} failed
              </span>
            )
          }
        >
          {shelfmark.jobs.length === 0 ? (
            <p className={EMPTY}>Queue is empty.</p>
          ) : (
            <ul className={TRANSFERS}>
              {shelfmark.jobs.map((j, i) => (
                <li key={`${j.title}-${String(i)}`} className={TRANSFER_ROW}>
                  <div className={TRANSFER_HEAD}>
                    <span className={TRANSFER_NAME} title={j.title}>
                      {j.title}
                    </span>
                    <span className={TRANSFER_META}>
                      <Chip tone={j.state === 'error' ? 'bad' : 'info'}>{j.state}</Chip>
                    </span>
                  </div>
                  <Progress
                    pct={j.pct}
                    tone={j.state === 'error' ? 'bad' : 'accent'}
                    active={j.state === 'downloading'}
                  />
                </li>
              ))}
            </ul>
          )}
        </Board>

        <Board title="Queue" icon="clock" span={4}>
          {counts === null ? (
            <p className={EMPTY}>no reading</p>
          ) : (
            <Measures
              items={[
                { k: 'Downloading', v: num(counts.downloading) },
                { k: 'Queued', v: num(counts.queued) },
                { k: 'Completed', v: num(counts.done) },
                {
                  k: 'Errors',
                  v: num(counts.errors),
                  tone: counts.errors > 0 ? 'warn' : undefined,
                },
              ]}
            />
          )}
        </Board>

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
