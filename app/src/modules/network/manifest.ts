import type { ModuleManifest } from '../../lib/modules/manifest'

export const manifest = {
  id: 'network',
  label: 'Network',
  lede: 'Everything between a packet and this box: the link, the ways in, the proxy, the resolver.',
  order: 50,
  boardSpans: [12, 12, 8, 4],
  // No tiles on any tab here. The nine that used to sit under General were
  // each a service already given a whole tab, restating three of its numbers
  // one screen below the panel that explains them, plus four bare links —
  // and every one of those links now lives on the tab whose subject it is.
  // Split by DIRECTION, because that is the only axis on which these two
  // are alike: both are WireGuard, both are tunnels, and everything else
  // about them is opposite. One lets a phone reach the house from a hotel;
  // the other stops the house being recognised from outside. Keeping them
  // as two boards on one page meant the words "VPN", "WireGuard" and
  // "tunnel" each meant two things a scroll apart.
  tabs: [
    // The wire itself, and everyone using it: what crosses the cable, what
    // the line behind it can carry, and which container moved which bytes.
    //
    // No gatus probe, because there is no one service here to check — but
    // the tab is not therefore unknowable. The two things that would make
    // this page meaningless are the router being unreachable and the
    // internet being down, and both are measured every minute, so the dot
    // is computed from them instead of left permanently grey.
    // The one tab in this module with no service head: its subject is the
    // cable, which has no version and nothing to open — and no nix module,
    // because the wire is the box's own.
    {
      id: 'general',
      label: 'General',
      boardSpans: [8, 4, 4, 8],
      head: false,
      health: 'uplink',
    },
    // Three ways in — WireGuard, the Cloudflare tunnel, and the address
    // itself — chosen by a switch inside the page. The probe is wg-easy's
    // because it is the only one of the three gatus can check. Two nix
    // modules, one per tunnel; ddclient is platform, not a stack.
    {
      id: 'wireguard',
      label: 'Coming in',
      probe: 'wg-easy',
      boardSpans: [8, 4, 12],
      nix: ['wg', 'cloudflared'],
    },
    // What happens to a request once it has arrived. Pocket ID shared this
    // tab and is its own category now: the routing table still borrows the
    // IdP's client list to say which routes are gated, but that is one
    // column, and a column is not a reason for a second service's header
    // and release notes to sit behind a switch on a page about routing.
    {
      id: 'proxy',
      label: 'Proxy',
      probe: 'traefik-dashboard',
      boardSpans: [12, 8, 4],
      nix: 'traefik',
    },
    // How a name becomes an address, on both sides of the front door: the
    // resolver every device in the house asks, and the zone the internet
    // asks. One tab because the interesting facts are the ones where the
    // two disagree — and because the registration underneath them is the
    // single expiry date every hostname, certificate and redirect URI on
    // this box hangs off. The probe is pi-hole's; nothing gatus can reach
    // says anything about a zone at Cloudflare.
    {
      id: 'dns',
      label: 'DNS',
      probe: 'pihole',
      boardSpans: [8, 4, 8, 4],
      nix: 'pihole',
    },
    // The other server inside the same process, and a separate tab because
    // sharing FTL is a fact about the software rather than about the
    // subject: one page answers what a name points at, this one answers
    // which device holds which address. Same probe — there is one process
    // to be up — and the same reason it can answer at all, which is that
    // everything in the house resolves through this box.
    {
      id: 'dhcp',
      label: 'DHCP',
      probe: 'pihole',
      boardSpans: [6, 6, 12],
      nix: 'pihole',
    },
    // No gatus probe: it checks HTTP endpoints, and a VPN egress tunnel
    // answers nothing — it is a network namespace. Its dot is computed from
    // every declared tunnel's state and its containers instead. One nix
    // module per gluetun instance: the download stack's and argus's.
    {
      id: 'outbound',
      label: 'Going out',
      health: 'vpn-egress',
      boardSpans: [8, 4, 12],
      nix: ['downloads', 'argus'],
    },
  ],
} as const satisfies ModuleManifest
