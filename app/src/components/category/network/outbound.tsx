import { useState } from 'react'
import type { NetworkData } from '../../../lib/dashboard/categories/network'
import { DASH, flag, pct, until } from '../../../lib/format'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import { LinkRow, ServiceHead } from '../../service-head'
import { Segmented } from '../../ui'
import type { Tone } from '../../viz'
import { Board, BoardGrid, Chip, Columns, Facts, Measures, Pulse } from '../../viz'
import { tone } from './shared'

// ── Going out: the egress tunnels ──────────────────────────────────────────

/**
 * Every VPN this box exits through, one at a time.
 *
 * A selector rather than a board per tunnel, and that is the whole design
 * decision here: there are two today and the shape of the page must not
 * depend on that. Each is the same set of questions — where does it come out,
 * has it stayed up, when does its key die, what loses the network with it —
 * so they get one page and a switch, and a third tunnel appears in the switch
 * by being declared. The list comes from `fleet.vpnEgress`, which
 * `mkGluetunInstance` writes itself.
 */
export function OutboundView({ data }: { data: Extract<NetworkData, { tab: 'outbound' }> }) {
  const [selected, setSelected] = useState(data.tunnels[0]?.key ?? '')
  const t = data.tunnels.find((x) => x.key === selected) ?? data.tunnels[0]

  if (t === undefined) {
    return (
      <BoardGrid>
        <Board title="Going out" icon="⇤" span={12}>
          <p className="viz-empty">{data.note ?? 'no VPN egress declared'}</p>
        </Board>
      </BoardGrid>
    )
  }

  const expiryTone: Tone | undefined =
    t.expiryDays < 0 ? 'bad' : t.expiryDays < 30 ? 'warn' : undefined

  return (
    <>
      <ServiceHead
        logo="/icon-gluetun.svg"
        // The SOFTWARE, not the selected tunnel: everything in the header —
        // the build, the verdict, the sentence — is identical whichever tunnel
        // is chosen, and the tunnel's own identity is a row of its own below,
        // next to the switch that picks it.
        name="VPN egress"
        version={data.gluetun.running}
        versionNote={
          data.gluetun.builtOn === null
            ? 'the gluetun build every tunnel runs'
            : `built ${data.gluetun.builtOn} · every tunnel runs it`
        }
        verdict={
          data.gluetun.running === null
            ? { label: 'unknown', tone: 'muted' }
            : data.gluetun.behind.length === 0
              ? { label: 'current', tone: 'ok' }
              : { label: `${String(data.gluetun.behind.length)} behind`, tone: 'warn' }
        }
        compare={[
          {
            k: 'Tunnels',
            v: String(data.tunnels.length),
            note: 'each its own key and its own exit — declared in fleet.vpnEgress',
          },
          { k: 'Pinned by', v: null, note: 'one image digest in platform/gluetun-lib.nix' },
        ]}
        lede={
          <>
            gluetun holds a WireGuard tunnel and owns a network namespace; the containers behind one
            borrow it outright rather than having interfaces of their own. It is fail-closed, so a
            tunnel that drops takes their internet with it — which is the point, and the reason this
            page exists.
          </>
        }
      />
      <LinkRow
        links={[
          { label: 'gluetun', href: 'https://github.com/qdm12/gluetun' },
          { label: 'ProtonVPN account', href: 'https://account.protonvpn.com/downloads' },
        ]}
      />

      {/* The SOFTWARE first, because it is shared: however many tunnels this
          page grows, `mkGluetunInstance` pins one gluetun digest and one
          exporter digest, so both builds are the same on every one of them.
          Repeating them per tunnel would print the same answer twice and
          invite the reader to check whether they differ. */}
      <BoardGrid>
        <Changelog
          build={data.gluetun}
          span={6}
          title={
            data.gluetun.behind.length === 0
              ? 'gluetun — current'
              : `gluetun — ${String(data.gluetun.behind.length)} commits behind`
          }
          aside={
            <span className="board-note">
              {data.gluetun.running === null ? (
                'build unknown'
              ) : (
                <span className="mono">{data.gluetun.running}</span>
              )}
              {data.gluetun.builtOn !== null && ` · built ${data.gluetun.builtOn}`}
            </span>
          }
          foot={
            <p className="board-foot">
              {/* Why this is not the release-notes panel every other service
                  gets — a correctness point, not a shortcut. */}
              Commits, not releases, and deliberately: this image is a digest-pinned{' '}
              <code>:latest</code>, which is master, and master has <b>diverged</b> from the v3.41.x
              release line — v3.41.2 ships an acknowledged port-forwarding deadlock this box would
              trip, because it sets <code>VPN_PORT_FORWARDING_UP_COMMAND</code>. A release list here
              would advise a downgrade into a known bug. The build is read out of gluetun’s own
              startup banner in Loki, since <code>/v1/version</code> is not in the control-server
              allow list and widening it would restart the tunnel.
            </p>
          }
        />

        <Changelog
          gap={data.exporter}
          span={6}
          title="gluetun-exporter"
          aside={<span className="board-note">version unknowable</span>}
          foot={
            <p className="board-foot">
              What has been <b>published</b>. Which of it is running cannot be said: the image is a
              digest-pinned <code>:latest</code> and the exporter prints no version in its log,
              serves none on <code>/metrics</code>, and has no endpoint that would answer. So this
              is the honest half — a release exists, and comparing it to what is here is a manual
              job. It polls each tunnel’s control API every 30 seconds and is what the VPN-down
              alert reads.
            </p>
          }
        />
      </BoardGrid>

      {/* Everything below is per TUNNEL — including the logs, which are the
          one thing here that genuinely differs between them. The switch sits
          on the boundary rather than in the header, so it is visibly the thing
          that governs what follows it and not what precedes it. */}
      <div className="tunnel-bar">
        {/* What the switch cannot say, and only that: where the selected
            tunnel comes out. Its name and its health are on the button. */}
        <span className="tunnel-id">
          <span className="mono">{t.exit.ip ?? DASH}</span>
          <span>{flag(t.exit.country)}</span>
          {t.portForwarding && t.port !== null && <span>port {t.port}</span>}
        </span>
        {data.tunnels.length > 1 && (
          <Segmented
            value={t.key}
            onChange={setSelected}
            options={data.tunnels.map((x) => ({
              value: x.key,
              // `gluetun` is the downloads one, historically unprefixed.
              label: x.container.replace(/^gluetun-?/, '') || 'downloads',
              dot: tone(x.up),
            }))}
          />
        )}
      </div>

      <BoardGrid>
        <Board
          title="Staying up"
          icon="⛨"
          span={8}
          aside={
            <span className="board-live">
              <Pulse on={t.up === true} tone={t.up === true ? 'ok' : 'bad'} />
              {t.up === null ? 'unknown' : t.up ? 'tunnel up' : 'tunnel down'}
            </span>
          }
        >
          <Measures
            items={[
              { k: '7 days', v: t.uptime7d === null ? DASH : pct(t.uptime7d * 100, 2) },
              {
                k: 'key expires',
                v: t.expiryDays < 0 ? `${String(-t.expiryDays)}d ago` : until(t.expiryDays * 86400),
                tone: expiryTone,
              },
              ...(t.portForwarding
                ? [{ k: 'forwarded port', v: t.port === null ? 'none yet' : String(t.port) }]
                : []),
            ]}
          />

          <Columns
            points={t.daily.map((d) => ({
              label: d.date.slice(5),
              value: d.uptime,
              display: `${pct(d.uptime * 100, 2)} up`,
              flag: d.uptime < 0.999,
            }))}
            tone="ok"
            height={112}
            empty="no history yet"
          />
          {t.daily.length > 0 && (
            <p className="colaxis">
              <span>{t.daily[0]?.date.slice(5)}</span>
              <span>share of the day connected</span>
              <span>{t.daily[t.daily.length - 1]?.date.slice(5)}</span>
            </p>
          )}

          <p className="board-foot">
            {/* A near-full column is the normal state, so the axis starting at
                zero is the honest choice AND the useless one — the flag is what
                carries a bad day. */}
            gluetun reports its own tunnel state every 30 seconds; this is the share of each day it
            said it was connected. Columns are near-full by design — a day that dropped at all is
            underlined in red rather than left to a difference of a pixel. The WireGuard key expires{' '}
            <b>{t.keyExpiry}</b>, reminder mail goes out 30 and 7 days ahead, and the renewal
            runbook is the header of <code>{t.runbook}</code>.
          </p>
        </Board>

        <Board
          title="What rides it"
          icon="◫"
          span={4}
          aside={<span className="board-note">{t.tenants.length} containers</span>}
        >
          <ul className="itemlist">
            {t.tenants.map((c) => (
              <li key={c.name}>
                <Chip tone={c.up === null ? 'muted' : c.up ? 'ok' : 'bad'}>
                  {c.up === null ? '?' : c.up ? 'up' : 'down'}
                </Chip>
                <span className="item-main mono">{c.name}</span>
              </li>
            ))}
          </ul>
          <p className="board-foot">
            Read from each container’s own <code>--network=container:{t.container}</code>, so this
            is the set that actually shares the namespace rather than a list kept beside it. They
            publish no ports of their own — only a namespace’s owner can — which is why every one of
            their UIs is published on the gluetun container instead.
          </p>
        </Board>

        <Board
          title="Where it comes out"
          icon="◍"
          span={12}
          aside={
            <span className="board-brand">
              <img src="/icon-protonvpn.svg" alt="" width={16} height={16} />
              {t.provider}
            </span>
          }
        >
          <Facts
            rows={[
              // `flag` already emits the country name beside the emoji.
              { k: 'Country', v: flag(t.exit.country) },
              { k: 'City', v: place(t.exit.city, t.exit.region) },
              { k: 'Address', v: <span className="mono">{t.exit.ip ?? DASH}</span> },
              { k: 'Carrier', v: t.exit.org ?? DASH },
              { k: 'Timezone', v: t.exit.timezone ?? DASH },
            ]}
          />
          <p className="board-foot">
            Asked of gluetun’s control API, which asks the provider — nothing on this box can answer
            it, because the container only ever sees a private tunnel address and the exit is only
            knowable from outside. The carrier is what an observer on the far side actually
            attributes this traffic to.
          </p>
        </Board>

        {/* The exporter is the one container genuinely tied to this tunnel and
            nothing else: it exists solely to poll this gluetun's control API,
            it shares its namespace, and it is where "the VPN alerts went
            quiet" is answered. */}
        <LogBoard
          source={{ container: t.container }}
          title={`${t.container} logs`}
          neighbours={[
            {
              source: { container: t.exporter },
              label: 'Exporter',
              role: 'the process the VPN alerts read',
              note: 'Polls this tunnel’s control API every 30 seconds and serves the gluetun_vpn_status and forwarded-port metrics behind the chart above and the VPN-down alert. If those go stale while the tunnel is fine, the answer is here — a wedged gluetun reads as "Up 4 days" with its ports listed while nothing is listening.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}

/**
 * "Miami, Florida" — but not "Zürich, Zurich".
 *
 * A city-state's region is its city under a different spelling, and the
 * provider reports both. Compared with diacritics stripped, because that IS
 * the difference in the case that matters.
 */
function place(city: string | null, region: string | null): string {
  const fold = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
  if (city === null || city === '') return region ?? DASH
  if (region === null || region === '' || fold(region) === fold(city)) return city
  return `${city}, ${region}`
}
