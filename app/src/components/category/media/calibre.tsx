import type { MediaData } from '../../../lib/dashboard/categories/media'
import { bytes, num } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../service-head'
import { Board, BoardGrid, Facts, Measures } from '../../viz'

/* ── Calibre ──────────────────────────────────────────────────────────── */

type Calibre = Extract<MediaData, { tab: 'calibre' }>

/**
 * The shelf, next to Jellyfin rather than paired with its downloader.
 *
 * Both are where a pipeline ENDS — the thing a person opens — which is what
 * the rule on the tab row divides. Pairing Calibre with Shelfmark instead put
 * one downloader on the far side of that line from the other three.
 */
export function CalibreView({ d }: { d: Calibre }) {
  const calibre = d
  const { disk } = d

  return (
    <>
      <ServiceHead
        logo="/icon-calibre-web.svg"
        name="Calibre"
        version={calibre.version}
        versionNote="from the tag the flake pins"
        verdict={verdictOf(calibre.gap)}
        compare={compareOf(calibre.gap, 'the image tag, since the app serves no version')}
        lede={
          <>
            The shelf itself: Calibre-Web-Automated ingests whatever lands in{' '}
            <span className="mono">/s2/books</span> and serves it to readers over OPDS and the web.
          </>
        }
        actions={<Open name="Calibre" host="calibre" />}
      />

      <BoardGrid>
        <Board title="The shelf" icon="❏" span={8}>
          <Facts
            rows={[
              { k: 'Books', v: num(calibre.books) },
              { k: 'Authors', v: num(calibre.authors) },
              { k: 'Series', v: num(calibre.series) },
              { k: 'Categories', v: num(calibre.categories) },
            ]}
          />
          <p className="board-foot">
            Read through the OPDS catalogue with its own credentials, the same endpoint an e-reader
            uses. It is the one path on this app that skips the Pocket ID gate.
          </p>
        </Board>

        <Board title="Disk" icon="grid" span={4}>
          <Measures
            items={[
              { k: 'On disk', v: bytes(disk.usedBytes) },
              { k: 'Free', v: bytes(disk.freeBytes) },
            ]}
          />
        </Board>

        <Changelog gap={calibre.gap} span={12} />

        <LogBoard source={{ container: 'calibre-web' }} title="Calibre-Web logs" />
      </BoardGrid>
    </>
  )
}
