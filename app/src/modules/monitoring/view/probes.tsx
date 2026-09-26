import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import {
  compareOf,
  Open,
  ServiceHead,
  SOURCE_NOTE,
  verdictOf,
} from '../../../components/service-head'
import { EMPTY, FOOT, MONO, NOTE, SUB } from '../../../components/tokens'
import { BarList, Board, BoardGrid, Chip, Facts } from '../../../components/viz'
import { DASH, num, pct } from '../../../lib/format'
import { useSite } from '../../../lib/site-context'
import type { MonitoringData } from '../data'
import { LIST, MAIN, NUM } from './shared'

// The Probes tab: gatus, the one watcher that looks at the box from outside —
// what is not answering, the worst week, certificates and the slowest answers.

type Probes = Extract<MonitoringData, { tab: 'probes' }>

export function ProbesView({ data: d }: { data: Probes }) {
  const site = useSite()
  return (
    <>
      <ServiceHead
        logo="/icon-gatus.svg"
        name="Gatus"
        version={d.running.version}
        versionNote={SOURCE_NOTE[d.running.source]}
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'the image tag — gatus publishes no version of its own')}
        lede={
          <>
            The only watcher that looks at this box from OUTSIDE it: every check here is a real
            HTTPS request through traefik and the forward-auth gate, on the same path a browser
            takes. So it is the one system that can notice a certificate, a router or an IdP
            failing. None of those is visible from a metric scraped on the inside.
          </>
        }
        // `status`, not `gatus`: the published label differs from the attribute
        // name here, as it does for Pocket ID and Open WebUI. Deriving one from
        // the other is how this dashboard grows links that 404.
        actions={<Open name="Gatus" host="status" />}
      />

      <BoardGrid>
        <Board
          title={d.failing.length === 0 ? 'Everything answering' : 'Not answering'}
          icon="◎"
          span={8}
          aside={
            <span className={NOTE}>
              {num(d.up)} up · {num(d.down)} down
            </span>
          }
        >
          {d.failing.length === 0 ? (
            <p className={EMPTY}>All {num(d.up)} endpoints answered their last probe.</p>
          ) : (
            <ul className={LIST}>
              {d.failing.map((f) => (
                <li key={f}>
                  <Chip tone="bad">down</Chip>
                  <span className={MAIN}>{f}</span>
                </li>
              ))}
            </ul>
          )}

          <h4 className={SUB}>Worst week</h4>
          <ul className={LIST}>
            {d.worst.map((w) => (
              <li key={w.name}>
                <span className={MAIN}>{w.name}</span>
                <span className={NUM}>{pct(w.uptime, 2)}</span>
              </li>
            ))}
          </ul>

          <p className={FOOT}>
            Ranked by the WORST seven days rather than the average, because an average over
            thirty-eight endpoints hides the one that is broken. Some of what you see here is not an
            outage: traefik dials the *arrs at a port published out of gluetun&rsquo;s rootless
            namespace, where a new connection stalls about ten seconds one time in forty, and gatus
            times out at ten. Roughly 2% of those probes fail against a service answering every
            request anybody made. That is why the tab dots elsewhere on this dashboard require three
            minutes of silence before they turn red.
          </p>
        </Board>

        <Board title="Certificates" icon="key" span={4}>
          <Facts
            rows={[
              { k: 'Soonest expiry', v: d.cert.days === null ? DASH : `${num(d.cert.days)} days` },
              { k: 'On', v: d.cert.host ?? DASH },
              { k: '24h uptime', v: pct(d.uptime24h, 2) },
            ]}
          />
          <p className={FOOT}>
            One entrypoint-level wildcard covers <span className={MONO}>*.{site.baseDomain}</span>,
            so this is one certificate for every hostname on the box. Renewal is DNS-01 through
            Cloudflare and automatic. A number falling below thirty means lego is failing, and the
            store is a single file that is in no backup.
          </p>
        </Board>

        <Board title="Slowest to answer" icon="⏱" span={4}>
          <BarList items={d.slowest} tone="warn" empty="nothing measured" />
          <p className={FOOT}>
            Probed from outside over HTTPS, so this includes TLS, the proxy and the forward-auth
            round trip, not just the app.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ container: 'gatus' }}
          title="Gatus logs"
          foot={
            <p className={FOOT}>
              Gatus fetches the OIDC discovery document while starting and panics if it is not being
              served yet, which is why it is one of the containers gated behind a bounded probe of
              the real discovery URL rather than ordered after Pocket ID. See{' '}
              <span className={MONO}>fleet.sso.discoveryConsumers</span>.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}
