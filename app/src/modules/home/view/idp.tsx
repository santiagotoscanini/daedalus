import { Changelog } from '../../../components/release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../../components/service-head'
import { Button } from '../../../components/ui/button'
import { BoardGrid } from '../../../components/viz'
import type { IdpData } from '../data/signin'
import { AppsSection, DeclaredSection, LogsBoard, SigningInBoard } from './idp-boards'
import { AccountsSection, DevicesSection, GroupsSection } from './idp-who'

/**
 * Pocket ID: who can get in, and who did. The audit log is the panel — see
 * `loadIdp` on why it is the only record of a sign-in.
 *
 * Read top down: how much signing in happened (the chart), who has an
 * account, the groups and the devices that hold a key, then the applications
 * it opened (the table the page is for), then the list that only matters when
 * it holds a surprise — a client nothing declares — then the releases and the
 * log.
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
            Passkeys only, so there is no password here to guess, phish or reuse. Every admin UI
            sits behind it, so one sign-in opens all of them for the day.
          </>
        }
        actions={
          <Button asChild size="sm" variant="outline">
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

        <AccountsSection d={d} />
        <GroupsSection d={d} />
        <DevicesSection d={d} />

        <AppsSection d={d} shared={shared} idle={idle} max={max} />

        {/* The join nothing else can make — see `IdpData['nix']`. */}
        <DeclaredSection d={d} />

        <Changelog gap={d.gap} span={12} />

        <LogsBoard />
      </BoardGrid>
    </>
  )
}
