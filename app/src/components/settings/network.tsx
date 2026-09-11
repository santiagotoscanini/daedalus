import { RouterIcon } from 'lucide-react'
import type { BoxSettings } from '../../core/settings/types'
import type { SiteEdit } from '../../core/site'
import {
  hostnameShapeError,
  interfaceError,
  ipv4Error,
  leaseTimeError,
  upstreamsError,
} from '../../lib/site-fields'
import { Section, SourceNote, Value } from './shared'
import { SiteList, SiteSwitch, SiteText, SiteUnwritten } from './site-fields'

/** Optional address: empty is null in the document, anything else is a quad. */
const gatewayError = (v: string) => (v.trim() === '' ? null : ipv4Error(v))

export function Network({ settings, edit }: { settings: BoxSettings; edit: SiteEdit }) {
  const n = settings.network
  return (
    <div className="flex flex-col gap-6">
      <SiteUnwritten edit={edit} />

      <Section
        title="Addresses"
        icon={<RouterIcon />}
        description="Where the box is on the LAN, and the one name that reaches it from anywhere."
        rows={[
          {
            k: 'LAN address',
            v: (
              <SiteText
                edit={edit}
                field="network.lanIp"
                label="LAN address"
                validate={ipv4Error}
              />
            ),
          },
          {
            k: 'Interface',
            v: (
              <SiteText
                edit={edit}
                field="network.interface"
                label="Interface"
                validate={interfaceError}
                nullable
              />
            ),
          },
          {
            k: 'Gateway',
            v: (
              <SiteText
                edit={edit}
                field="network.gateway"
                label="Gateway"
                validate={gatewayError}
                nullable
              />
            ),
          },
          {
            k: 'Public hostname',
            v: (
              <SiteText
                edit={edit}
                field="network.wanHost"
                label="Public hostname"
                validate={hostnameShapeError}
              />
            ),
          },
        ]}
      >
        <p className="m-0 text-[0.78rem] text-(--text-muted)">
          The LAN address is the box's own. A wrong value strands it after the rebuild — the DNS
          server, this page and SSH all move with it — and the way back in is SSH by the new
          address. An empty interface or gateway leaves the choice to the kernel.
        </p>
        <p className="m-0 text-[0.78rem] text-(--text-muted)">
          The public hostname is split-horizon: Pi-hole answers it with the LAN address, the public
          record carries the WAN address. It stays DNS-only at Cloudflare — proxying it would break
          the router-forwarded games and mask the LAN override.
        </p>
      </Section>

      <Section
        title="Dynamic DNS"
        icon="/icon-cloudflare.svg"
        description="ddclient keeps the public record on the ISP's current address."
        rows={[
          { k: 'Record', v: <Value v={n.ddns.host} /> },
          { k: 'Poll interval', v: <Value v={n.ddns.interval} /> },
        ]}
      />

      <Section
        title="DHCP"
        icon="/icon-pihole.svg"
        description="Pi-hole's scope for the household. Reservations live in an encrypted hosts file and are on the Network › DHCP tab."
        rows={[
          {
            k: 'Server',
            v: <SiteSwitch edit={edit} field="network.dhcp.active" label="DHCP server" />,
          },
          {
            k: 'Range',
            v: (
              <span className="inline-flex flex-wrap items-center justify-end gap-2">
                <SiteText
                  edit={edit}
                  field="network.dhcp.start"
                  label="Range start"
                  validate={ipv4Error}
                  className="w-[9.5rem]"
                />
                <span className="text-(--dim)">–</span>
                <SiteText
                  edit={edit}
                  field="network.dhcp.end"
                  label="Range end"
                  validate={ipv4Error}
                  className="w-[9.5rem]"
                />
              </span>
            ),
          },
          {
            k: 'Lease',
            v: (
              <SiteText
                edit={edit}
                field="network.dhcp.leaseTime"
                label="Lease"
                validate={leaseTimeError}
                className="w-[9.5rem]"
              />
            ),
          },
          {
            k: 'Router handed out',
            v: (
              <SiteText
                edit={edit}
                field="network.dhcp.router"
                label="Router handed out"
                validate={ipv4Error}
              />
            ),
          },
        ]}
      >
        <p className="m-0 text-[0.78rem] text-(--text-muted)">
          Turning the server off leaves every device on its current lease until it expires, then
          without an address unless something else hands them out. The lease is dnsmasq syntax: a
          number with an optional s/m/h/d/w unit, or <code>infinite</code>.
        </p>
      </Section>

      <Section
        title="DNS"
        icon="/icon-pihole.svg"
        description="Every device in the house resolves through Pi-hole; these are what Pi-hole itself asks."
        rows={[
          {
            k: 'Upstreams',
            v: (
              <SiteList
                edit={edit}
                field="network.dnsUpstreams"
                label="Upstreams"
                validate={upstreamsError}
              />
            ),
          },
          { k: 'Local records', v: <Value v={String(n.dns.lanHosts)} unit="hosts" /> },
        ]}
      >
        <p className="m-0 text-[0.78rem] text-(--text-muted)">
          One upstream per line, as an address with an optional <code>#port</code>. Every container
          on the box resolves through Pi-hole too, so an upstream that does not answer is a
          house-wide outage, not a slow lookup.
        </p>
      </Section>

      <SourceNote
        meta={settings.sources.network}
        file="/export/network.json"
        producer="daedalus-export-publish at activation"
      />
    </div>
  )
}
