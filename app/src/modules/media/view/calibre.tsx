import { LogBoard } from '../../../components/logs'
import { Changelog, VersionAside } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { Board, BoardGrid, Facts } from '../../../components/viz'
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
        {/* One board: the disk figures were a board of their own holding two
            numbers, the short half of a pair. They are the shelf's size. */}
        <Board title="The shelf" icon="❏" span={12}>
          <Facts
            rows={[
              { k: 'Books', v: num(calibre.books) },
              { k: 'Authors', v: num(calibre.authors) },
              { k: 'Series', v: num(calibre.series) },
              { k: 'Categories', v: num(calibre.categories) },
              { k: 'On disk', v: bytes(disk.usedBytes) },
              { k: 'Free', v: bytes(disk.freeBytes) },
            ]}
          />
          <p className={FOOT}>
            Read through the OPDS catalogue with its own credentials, the same endpoint an e-reader
            uses. It is the one path on this app that skips the Pocket ID gate.
          </p>
        </Board>

        <Changelog gap={calibre.gap} span={12} />
        <Changelog
          gap={calibre.mcp.gap}
          span={12}
          title="Calibre-Web MCP"
          aside={
            <VersionAside version={calibre.mcp.version} behind={calibre.mcp.gap.behind.length} />
          }
          foot={
            <p className={FOOT}>
              The shelf as tools on the LLM gateway: search it, look a book up, send one to the
              Kindle, mark it read, file it on a shelf. Our own repository, built on the box from
              the flake input of the same name, so a new version is a push there and{' '}
              <span className={MONO}>nix flake update calibre-web-mcp</span>.
            </p>
          }
        />

        <LogBoard
          source={{ container: 'calibre-web' }}
          title="Calibre-Web logs"
          neighbours={[
            {
              source: { container: 'mcp-calibre-web' },
              label: 'Calibre-Web MCP',
              role: 'the tool server in front of it',
              note: 'It signs in as the library’s user on Calibre-Web’s private bridge. A send to the Kindle is queued by Calibre-Web, so whether the email went out is in Calibre-Web’s log, not this one.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}
