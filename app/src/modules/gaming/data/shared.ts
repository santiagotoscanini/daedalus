import { siteIdentity } from '../../../host/contract/domains/site'

// What both Gaming tabs read: the one address the two game servers are
// reached by.

/**
 * The name both game servers are reached by, from anywhere.
 *
 * Not a literal: pi-hole answers it with the LAN address and Cloudflare with
 * the WAN one (kept current by nix/platform/ddclient), which is the whole
 * reason there is a single address to print. `fleet.wanHost`, from
 * /export/site.json, because a second copy of a hostname goes stale.
 */
export async function wanHost(): Promise<string> {
  return (await siteIdentity()).data.wanHost
}
