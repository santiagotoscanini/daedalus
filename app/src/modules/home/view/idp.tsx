import { Changelog } from '../../../components/release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../../components/service-head'
import { Button } from '../../../components/ui/button'
import { BoardGrid } from '../../../components/viz'
import type { IdpData } from '../data/signin'
import { DeclaredBoard, LogsBoard, SigningInBoard, WhoBoard } from './idp-boards'

/**
 * Pocket ID: who can get in, and who did. The audit log is the panel — see
 * `loadIdp` on why it is the only record of a sign-in.
 */
export function IdpView({ data: d }: { data: IdpData }) {
  const { window: w } = d
  const shared = d.clients.filter((c) => c.sharesHost)
  const idle = d.clients.filter((c) => c.used === 0).length
  // The bar's scale. Not the list's order — see the note on the loader.
  const max = Math.max(...d.clients.map((c) => c.used), 1)

  return (
    <>
      <ServiceHead
        logo="/icon-pocket-id.svg"
        name="Pocket ID"
        version={d.version}
        versionNote="pinned in the flake"
        verdict={verdictOf(d.gap)}
        compare={[
          {
            k: 'Latest',
            v: d.gap.latest,
            note:
              d.gap.latest === null
                ? 'GitHub did not answer'
                : d.gap.behind.length === 0
                  ? 'this is what is running'
                  : `${String(d.gap.behind.length)} release${d.gap.behind.length === 1 ? '' : 's'} between them`,
          },
          {
            k: 'Pinned by',
            v: null,
            note: 'an exact tag in stacks/pocket-id — it serves no version',
          },
        ]}
        lede={
          <>
            Passkeys only. There is no password on this box to guess, phish or reuse. Every admin UI
            either sits behind it at the proxy or signs in against it directly, so a single
            authentication here is what opens all of them for the day.
          </>
        }
        actions={
          <Button asChild size="sm">
            <a href={d.url} target="_blank" rel="noreferrer">
              Open Pocket ID ↗
            </a>
          </Button>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://pocket-id.org/docs/introduction' },
          { label: 'GitHub', href: 'https://github.com/pocket-id/pocket-id' },
        ]}
      />

      <BoardGrid>
        {/* One board, not a chronological sign-in list beside the per-app
            aggregate: both are the same audit log, and a chronological list
            fills with whatever re-authorises on a timer. The per-row
            drill-down keeps the part an aggregate loses — who, from what. */}
        <SigningInBoard d={d} w={w} shared={shared} idle={idle} max={max} />

        <Changelog gap={d.gap} span={6} />

        {/* The join nothing else can make — see `IdpData['nix']`. */}
        <DeclaredBoard d={d} />

        <WhoBoard d={d} />

        <LogsBoard />
      </BoardGrid>
    </>
  )
}
