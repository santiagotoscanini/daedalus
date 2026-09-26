import type { Ctx } from '../../../core/ctx'

// What both Gaming tabs read: the one address the two game servers are
// reached by.

/**
 * The name both game servers are reached by, from anywhere.
 *
 * Not a literal: pi-hole answers it with the LAN address and Cloudflare with
 * the WAN one, which is the whole reason there is a single address to print.
 * See platform/ddclient. Read from the env rather than retyped here, because
 * a second copy of a hostname is a second copy that goes stale.
 */
export const wanHost = (ctx: Ctx) => ctx.env('WAN_HOST') ?? ''
