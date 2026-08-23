import { DASH } from '../../lib/format'
import type { AppTabData } from '../../server/registry'
import { Board, BoardGrid, Facts, Stat, StatStrip } from '../viz'
import type { AppRecord } from './shared'

/**
 * The VPN this app's traffic exits through.
 *
 * An egress app has no network stack of its own: it borrows a gluetun
 * container's namespace outright, which is why gluetun publishes the app's
 * host port and why the app cannot be reached any other way. Everything below
 * therefore describes that gluetun instance, scraped under a prometheus job
 * named after the container.
 */
export function Vpn({
  app,
  data,
}: {
  app: AppRecord
  data: Extract<AppTabData, { kind: 'vpn' }>['vpn']
}) {
  if (app.egressContainer === null) {
    return (
      <p className="lede">
        This app’s traffic leaves the house directly. Egress is set in Nix rather than here: it
        pairs a gluetun container with a host port, and both move together.
      </p>
    )
  }

  return (
    <>
      <StatStrip>
        <Stat
          label="Tunnel"
          value={data.up === null ? 'unknown' : data.up ? 'connected' : 'down'}
          tone={data.up === null ? 'warn' : data.up ? 'ok' : 'bad'}
          sub={data.uptime24h === null ? 'no history yet' : `${data.uptime24h.toFixed(2)}% of 24h`}
        />
        <Stat label="Exit" value={data.country ?? DASH} sub={data.city ?? 'no location'} />
        <Stat label="Public IP" value={data.ip ?? DASH} sub="what this app appears as" />
        <Stat
          label="Forwarded port"
          value={data.forwardedPort === null ? DASH : String(data.forwardedPort)}
          // Only ProtonVPN's port-forwarding instances get one, and the TV
          // stack is the only thing here that needs inbound.
          sub={data.forwardedPort === null ? 'none requested' : 'inbound reaches the app'}
        />
      </StatStrip>

      <BoardGrid>
        <Board title="Namespace" icon="⇄" span={6}>
          <Facts
            list
            rows={[
              { k: 'netns owner', v: <code>{app.egressContainer}</code> },
              { k: 'host port', v: <code>{String(app.egressHostPort)}</code> },
              { k: 'scrape job', v: <code>{app.egressContainer}</code> },
            ]}
          />
          <p className="board-foot">
            The app runs with <code>--network=container:{app.egressContainer}</code>, so it has no
            interfaces of its own. Only the namespace owner may publish a port, which is why the
            app’s host port is declared on gluetun.
          </p>
        </Board>

        <Board title="What this protects" icon="⛨" span={6}>
          <Facts
            list
            rows={[
              { k: 'all outbound', v: 'through the tunnel' },
              { k: 'kill switch', v: 'traffic drops with the tunnel' },
              { k: 'DNS', v: 'resolved inside the namespace' },
            ]}
          />
          <p className="board-foot">
            If the tunnel drops, the app loses the network rather than falling back to the house
            connection. That is the point of borrowing the namespace instead of routing.
          </p>
        </Board>
      </BoardGrid>

      <p className="strip-foot">
        Read from the gluetun exporter’s prometheus job rather than from gluetun’s control API, so
        it works the same for every instance and needs no per-app port table.
      </p>
    </>
  )
}
