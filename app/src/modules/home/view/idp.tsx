import { Changelog } from '../../../components/release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../../components/service-head'
import { Button } from '../../../components/ui/button'
import { BoardGrid } from '../../../components/viz'
import type { IdpData } from '../data/signin'
import { AppsBoard, DeclaredBoard, LogsBoard, SigningInBoard } from './idp-boards'
import { DevicesBoard, WhoBoard } from './idp-who'

/**
 * Pocket ID: who can get in, and who did. The audit log is the panel — see
 * `loadIdp` on why it is the only record of a sign-in.
 *
 * Read top down: how much signing in happened and who has an account (the
 * two readings), then the applications it opened (the table the page is
 * for), then the two lists that only matter when they hold a surprise — a
 * device nobody recognises, a client nothing declares — then the releases
 * and the log.
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
        <SigningInBoard d={d} w={w} />
        <WhoBoard d={d} />

        <AppsBoard d={d} shared={shared} idle={idle} max={max} />

        <DevicesBoard d={d} />
        {/* The join nothing else can make — see `IdpData['nix']`. */}
        <DeclaredBoard d={d} />

        <Changelog gap={d.gap} span={12} />

        <LogsBoard />
      </BoardGrid>
    </>
  )
}
