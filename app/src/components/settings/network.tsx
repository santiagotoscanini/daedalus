import type { BoxSettings } from '../../core/settings/types'
import { Chip } from '../viz'
import { Mono, Section, SourceNote, Unset, Value } from './shared'

export function Network({ settings }: { settings: BoxSettings }) {
  const n = settings.network
  return (
    <div className="flex flex-col gap-6">
      <Section
        title="Addresses"
        description="Where the box is on the LAN, and the one name that reaches it from anywhere."
        rows={[
          { k: 'LAN address', v: <Value v={n.lanIp} /> },
          { k: 'Interface', v: <Value v={n.interface} /> },
          { k: 'Gateway', v: <Value v={n.gateway} /> },
          { k: 'Public hostname', v: <Value v={n.wanHost} /> },
        ]}
      >
        <p className="m-0 text-[0.78rem] text-(--text-muted)">
          The public hostname is split-horizon: Pi-hole answers it with the LAN address, the public
          record carries the WAN address. It stays DNS-only at Cloudflare — proxying it would break
          the router-forwarded games and mask the LAN override.
        </p>
      </Section>

      <Section
        title="Dynamic DNS"
        description="ddclient keeps the public record on the ISP's current address."
        rows={[
          { k: 'Record', v: <Value v={n.ddns.host} /> },
          { k: 'Poll interval', v: <Value v={n.ddns.interval} /> },
        ]}
      />

      <Section
        title="DHCP"
        description="Pi-hole's scope for the household. Reservations live in an encrypted hosts file and are on the Network › DHCP tab."
        rows={[
          {
            k: 'Server',
            v: n.dhcp.active ? <Chip tone="ok">active</Chip> : <Chip tone="muted">off</Chip>,
          },
          {
            k: 'Range',
            v:
              n.dhcp.start === '' ? (
                <Unset />
              ) : (
                <Mono>
                  {n.dhcp.start} – {n.dhcp.end}
                </Mono>
              ),
          },
          { k: 'Lease', v: <Value v={n.dhcp.leaseTime} /> },
          { k: 'Router handed out', v: <Value v={n.dhcp.router} /> },
        ]}
      />

      <Section
        title="DNS"
        description="Every device in the house resolves through Pi-hole; these are what Pi-hole itself asks."
        rows={[
          {
            k: 'Upstreams',
            v:
              n.dns.upstreams.length === 0 ? (
                <Unset />
              ) : (
                <span className="inline-flex flex-wrap justify-end gap-x-2">
                  {n.dns.upstreams.map((u) => (
                    <Mono key={u}>{u}</Mono>
                  ))}
                </span>
              ),
          },
          { k: 'Local records', v: <Value v={String(n.dns.lanHosts)} unit="hosts" /> },
        ]}
      />

      <SourceNote
        meta={settings.sources.network}
        file="/export/network.json"
        producer="daedalus-export-publish at activation"
      />
    </div>
  )
}
