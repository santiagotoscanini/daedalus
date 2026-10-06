import { LogBoard } from '../../../../components/logs'
import { Changelog } from '../../../../components/release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../../../components/service-head'
import { Button } from '../../../../components/ui/button'
import { Board, BoardGrid, Columns, Measures, Pulse } from '../../../../components/viz'
import { cn } from '../../../../lib/cn'
import { ms, num, since } from '../../../../lib/format'
import { stripBaseDomain } from '../../../../lib/site'
import { useSite } from '../../../../lib/site-context'
import { AXIS, CAPTION, EMPTY, FOOT, LIVE, MAIN, MONO, NOTE, ROW, ROWS, SIDE } from '../shared'
import type { Inbound } from './index'

/**
 * The Cloudflare tunnel, from both ends.
 *
 * Cloudflare knows what the edge sees; cloudflared knows what this box sent.
 * The panel that matters is the second one: `published` is every hostname the
 * tunnel will answer for, which is the literal answer to "what of this house
 * is reachable from the internet" — a question no other page here asks, and
 * one whose wrong answer is a service exposed by accident.
 */
export function CfTunnelView({ t }: { t: Inbound['tunnel'] }) {
  const site = useSite()
  const f = cfTunnelFacts({ t }, site)

  return (
    <>
      <ServiceHead
        logo="/icon-cloudflare.svg"
        name="Cloudflare tunnel"
        version={t.version}
        versionNote="cloudflared, as the edge reports it"
        verdict={verdictOf(t.gap)}
        compare={[
          {
            k: 'Latest',
            v: t.gap.latest,
            note:
              t.gap.latest === null
                ? 'GitHub did not answer'
                : t.gap.behind.length === 0
                  ? 'this is what is running'
                  : `${String(t.gap.behind.length)} release${t.gap.behind.length === 1 ? '' : 's'} between them`,
          },
          { k: 'Pinned by', v: null, note: 'a digest in stacks/cloudflared' },
        ]}
        lede={
          <>
            An <b>outbound</b> connection cloudflared holds open to Cloudflare, which the edge then
            reaches this box through. So the router never accepts an inbound connection for it: no
            forwarded port, nothing to scan. Everything it carries is HTTP, terminated at traefik’s{' '}
            <code>cfweb</code> entrypoint on plain HTTP because the edge already did TLS.
          </>
        }
        actions={
          <Button asChild size="sm">
            <a href="https://one.dash.cloudflare.com/" target="_blank" rel="noreferrer">
              Cloudflare dashboard ↗
            </a>
          </Button>
        }
      />
      <LinkRow
        links={[
          { label: 'cloudflared', href: 'https://github.com/cloudflare/cloudflared' },
          {
            label: 'Docs',
            href: 'https://developers.cloudflare.com/cloudflare-one/networks/connectors/cloudflare-tunnel/',
          },
        ]}
      />

      <BoardGrid>
        <HoldingTheTunnelBoard f={f} />

        <PublishedToTheWorldBoard f={f} />

        <Changelog gap={t.gap} />

        <CloudflaredLogsBoard />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function cfTunnelFacts({ t }: { t: Inbound['tunnel'] }, site: ReturnType<typeof useSite>) {
  const healthy = t.status === 'healthy'
  return { t, healthy, site }
}

type CfTunnelFacts = NonNullable<ReturnType<typeof cfTunnelFacts>>

function HoldingTheTunnelBoard({ f }: { f: CfTunnelFacts }) {
  const { t, healthy } = f
  return (
    <Board
      title="Holding the tunnel"
      icon="⇥"
      span={8}
      aside={
        <span className={LIVE}>
          <Pulse on={healthy} tone={healthy ? 'ok' : 'bad'} />
          {t.cfError !== null ? 'not readable' : (t.status ?? 'unknown')}
        </span>
      }
    >
      <Measures
        items={[
          { k: 'connections', v: num(t.connections) },
          { k: 'edge round trip', v: ms(t.rttMs) },
          { k: 'held for', v: since(t.heldForSeconds).replace(' ago', '') },
          {
            k: 'errors',
            v: num(t.errors),
            tone: t.errors !== null && t.errors > 0 ? 'bad' : undefined,
          },
        ]}
      />
      {t.cfError !== null && <p className={EMPTY}>{t.cfError}</p>}

      <Columns
        points={t.daily.map((d) => ({
          label: d.date.slice(5),
          value: d.requests,
          display: `${num(d.requests)} request${d.requests === 1 ? '' : 's'}`,
        }))}
        height={112}
        empty="no history yet"
      />
      {t.daily.length > 0 && (
        <p className={AXIS}>
          <span>{t.daily[0]?.date.slice(5)}</span>
          <span>requests from outside, per day</span>
          <span>{t.daily[t.daily.length - 1]?.date.slice(5)}</span>
        </p>
      )}

      <p className={CAPTION}>
        Four connections into{' '}
        {t.edges.length === 0
          ? 'the edge.'
          : `${t.edges.map((e) => `${e.colo}×${String(e.count)}`).join(' · ')}.`}
      </p>
      <p className={FOOT}>
        Two datacentres, so losing one is a reconnect rather than an outage. The counts are small on
        purpose: almost everything here is reached over the LAN, and the tunnel only carries what is
        genuinely away from home. <b>Held for</b> is the oldest connection, not the newest, since
        the newest may have rotated seconds ago and says nothing.
      </p>
    </Board>
  )
}

function PublishedToTheWorldBoard({ f }: { f: CfTunnelFacts }) {
  const { t, site } = f
  return (
    <Board
      title="Published to the world"
      icon="◍"
      span={4}
      aside={<span className={NOTE}>{t.published.length} hostnames</span>}
    >
      {t.published.length === 0 ? (
        <p className={EMPTY}>{t.cfError ?? 'could not read the tunnel’s ingress rules'}</p>
      ) : (
        <ul className={ROWS}>
          {t.published.map((p) => (
            <li key={p.hostname} className={ROW}>
              <span className={MAIN}>{stripBaseDomain(site, p.hostname)}</span>
              <span className={cn(MONO, SIDE)}>{p.service.replace(/^https?:\/\//, '')}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        Read back from the tunnel’s own ingress rules, which is the only list that decides anything.
        A hostname here is reachable from the internet; one that is not here is not, whatever DNS
        says. Every entry is generated by a <code>webApps.exposeRemotely</code>, so this is that
        decision as Cloudflare received it. They all point at the same place: traefik’s plain-HTTP{' '}
        <code>cfweb</code> entrypoint.
      </p>
    </Board>
  )
}

function CloudflaredLogsBoard() {
  return (
    <LogBoard
      source={{ container: 'cloudflared' }}
      title="cloudflared logs"
      neighbours={[
        {
          source: { unit: 'cloudflared-route-sync.service' },
          label: 'Route sync',
          role: 'what puts the public names in the zone',
          note: 'A oneshot that upserts one CNAME per fleet.cloudflareRoutes entry into the Cloudflare zone. The tunnel coming up proves nothing about whether a hostname resolves to it. A route declared in nix whose CNAME was never written is this unit having failed, and that is invisible from the tunnel’s own log.',
        },
      ]}
    />
  )
}
