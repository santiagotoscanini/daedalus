import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../../components/service-head'
import { Button } from '../../../components/ui/button'
import { BoardGrid } from '../../../components/viz'
import { useSite } from '../../../lib/site-context'
import type { NetworkData } from '../data'
import { CertificatesBoard, EntrypointsBoard, TrafficBoard } from './proxy-boards'
import { PublishedTable } from './proxy-routes'
import { FOOT } from './shared'

// One page, one subject. The protection column is drawn from Pocket ID's
// client list (see `loadProxy`), but a join is a reason for a column, not for
// a second service's header.
export type ProxyData = Extract<NetworkData, { tab: 'proxy' }>

/**
 * traefik: what is published, and what it did with it.
 *
 * The routing table leads because it is the one thing here that exists
 * nowhere else — nix declares the intent, and this is what traefik actually
 * built out of it, including the routers it refused.
 */
export function TraefikView({ data: d }: { data: ProxyData }) {
  const site = useSite()
  const { traffic, counts } = d
  const busy = traffic.rpm !== null && traffic.rpm > 0
  const groups = (['app', 'gate', 'client'] as const)
    .map((p) => ({ p, rows: d.routes.filter((r) => r.protection === p) }))
    .filter((g) => g.rows.length > 0)
  const remote = d.routes.filter((r) => r.remote).length

  return (
    <>
      <ServiceHead
        logo="/icon-traefik.svg"
        name="Traefik"
        version={d.version}
        versionNote={d.codename === null ? 'from its own API' : `“${d.codename}”, from its own API`}
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
            k: 'Read from',
            v: null,
            // Worth stating: most versions on this dashboard are the tag the
            // flake pinned, which is what was ASKED for.
            note: 'the running process, not the tag in the flake',
          },
        ]}
        lede={
          <>
            Every hostname on this box resolves to this one process. It terminates TLS, picks a
            container by name and, for about half of them, asks Pocket ID first.
          </>
        }
        actions={
          <Button asChild size="sm" variant="outline">
            <a href={d.dashboardUrl} target="_blank" rel="noreferrer">
              Open the dashboard ↗
            </a>
          </Button>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://doc.traefik.io/traefik/' },
          { label: 'GitHub', href: 'https://github.com/traefik/traefik' },
        ]}
      />

      <BoardGrid>
        <PublishedTable d={d} site={site} counts={counts} groups={groups} remote={remote} />

        <TrafficBoard d={d} traffic={traffic} counts={counts} busy={busy} />

        <EntrypointsBoard traffic={traffic} />

        <CertificatesBoard d={d} />

        <Changelog gap={d.gap} span={8} />

        {/* No neighbours. cloudflared dials the cfweb entrypoint and is the
            obvious candidate, but it has its own page one tab over — and a
            second copy of a log stream is not a second source. */}
        <LogBoard
          source={{ container: 'traefik' }}
          title="Traefik logs"
          foot={
            <p className={FOOT}>
              The service log, not the access log: startup, certificate renewals, configuration
              reloads and the errors behind a router that refused to build. Per-request lines go to
              the access log, which is not shipped here; the metrics above are what that answers.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}
