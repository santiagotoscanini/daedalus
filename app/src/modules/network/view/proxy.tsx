import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../../components/service-head'
import { Button } from '../../../components/ui/button'
import type { Tone } from '../../../components/viz'
import { Board, BoardGrid, Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { compact, DASH, num } from '../../../lib/format'
import type { Site } from '../../../lib/site'
import { stripBaseDomain } from '../../../lib/site'
import { useSite } from '../../../lib/site-context'
import type { NetworkData } from '../data'
import { CertificatesBoard, EntrypointsBoard, TrafficBoard } from './proxy-boards'
import { CAPTION, FOOT, MAIN, MONO, N, NOTE, ROW, SUB } from './shared'

// One page, one subject. The protection column is drawn from Pocket ID's
// client list (see `loadProxy`), but a join is a reason for a column, not for
// a second service's header.
export type ProxyData = Extract<NetworkData, { tab: 'proxy' }>

/** How each protection class reads, and in what order the table groups them. */
const PROTECTION: Record<
  ProxyData['routes'][number]['protection'],
  { title: string; note: string; tone: Tone }
> = {
  app: {
    title: 'The app decides',
    note: 'traefik routes these straight through. Whatever login they have is their own, and this page cannot see it. Several of them do have one.',
    tone: 'muted',
  },
  gate: {
    title: 'Behind the gate',
    note: 'A forward-auth middleware. The request goes to Pocket ID first and only reaches the app once it has come back authenticated, so the app never sees an anonymous request at all.',
    tone: 'ok',
  },
  client: {
    title: 'Signs in against Pocket ID itself',
    note: 'No middleware. The app is a registered OIDC client and runs the login itself, which means it also decides what an unauthenticated request gets.',
    tone: 'info',
  },
}

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
            Every hostname on this box resolves to one process, and this is it. It terminates the
            TLS, picks a container by the name in the request, and — for about half of them — asks
            Pocket ID whether the request should go any further.
          </>
        }
        actions={
          <Button asChild size="sm">
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
        <PublishedBoard d={d} site={site} counts={counts} groups={groups} remote={remote} />

        <TrafficBoard d={d} traffic={traffic} counts={counts} busy={busy} />

        <CertificatesBoard d={d} />

        <EntrypointsBoard traffic={traffic} />

        <Changelog gap={d.gap} span={9} />

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

function PublishedBoard({
  d,
  site,
  counts,
  groups,
  remote,
}: {
  d: ProxyData
  site: Site
  counts: ProxyData['counts']
  groups: { p: ProxyData['routes'][number]['protection']; rows: ProxyData['routes'] }[]
  remote: number
}) {
  return (
    <Board
      title="What is published, and what protects it"
      icon="⇄"
      span={12}
      aside={
        <span className={NOTE}>
          {d.routes.length} hostnames · {remote} also off-LAN
        </span>
      }
    >
      {groups.map((g) => (
        <section key={g.p} className="flex flex-col gap-1.5 not-first:mt-4">
          {/* The count belongs to the heading, so it sits on the baseline
              with it rather than pushing the row taller. */}
          <h4 className={cn(SUB, 'flex items-center gap-2')}>
            {PROTECTION[g.p].title}
            <Chip tone={PROTECTION[g.p].tone}>{g.rows.length}</Chip>
          </h4>
          {/* Forty-odd hostnames down a single column is a scroll, not a
              table. Columns as wide as the longest name and as many as
              fit, so the whole set is one glance — which is the only
              reading that answers "is anything unprotected". */}
          <ul className="m-0 grid list-none grid-cols-[repeat(auto-fill,minmax(15rem,1fr))] gap-x-2 gap-y-1 p-0">
            {g.rows.map((r) => (
              <li key={r.host} className={ROW} title={r.via ?? undefined}>
                <span className={cn(MAIN, MONO)}>{stripBaseDomain(site, r.host)}</span>
                {/* The chip is the whole point of the row: off-LAN means
                    the internet can ask, and the protection column beside
                    it says what answers. */}
                {r.remote && <Chip tone="warn">off-LAN</Chip>}
                {r.disabled && <Chip tone="bad">disabled</Chip>}
                {/* An em dash is not zero: traefik labels no request
                    counters for its own dashboard's router, and a 0 there
                    would read as "nobody has opened it". */}
                <span className={N}>{r.requests === null ? DASH : compact(r.requests)}</span>
              </li>
            ))}
          </ul>
          <p className={FOOT}>{PROTECTION[g.p].note}</p>
        </section>
      ))}

      <p className={FOOT}>
        One row per hostname rather than per router, because a name published both on the LAN and
        through the tunnel is two routers for one thing. Read from the configuration traefik built,
        not from what the flake asked for, which is the point of looking. The count on the right is
        requests over {d.windowDays} days.
      </p>
      {counts.errors > 0 && (
        <p className={CAPTION}>
          <b>
            {num(counts.errors)} piece{counts.errors === 1 ? '' : 's'} of configuration failed to
            build.
          </b>{' '}
          A router that does not exist answers nothing, quietly.
        </p>
      )}
    </Board>
  )
}
