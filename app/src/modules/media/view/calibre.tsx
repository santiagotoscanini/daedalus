import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { Board, BoardGrid, Facts, Measures } from '../../../components/viz'
import { bytes, num } from '../../../lib/format'
import type { MediaData } from '../data'
import { FOOT, MONO } from './shared'

/* ── Calibre ──────────────────────────────────────────────────────────── */

type Calibre = Extract<MediaData, { tab: 'calibre' }>

/** The shelf, next to Jellyfin rather than paired with its downloader — see `CalibreData`. */
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
            <span className={MONO}>/s2/books</span> and serves it to readers over OPDS and the web.
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
          <p className={FOOT}>
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
