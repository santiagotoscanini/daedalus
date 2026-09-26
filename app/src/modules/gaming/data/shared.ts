import type { Ctx } from '../../../core/ctx'

// What both Gaming tabs read: the one address the two game servers are
// reached by.

/**
 * The name both game servers are reached by, from anywhere.
 *
 * Not a literal: pi-hole answers it with the LAN address and Cloudflare with
 * the WAN one (kept current by nix/platform/ddclient), which is the whole
 * reason there is a single address to print. `WAN_HOST` is bound from
 * `fleet.wanHost`, because a second copy of a hostname goes stale.
 */
export const wanHost = (ctx: Ctx) => ctx.env('WAN_HOST') ?? ''
