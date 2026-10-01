import { createFileRoute } from '@tanstack/react-router'
import { readCapped } from '../lib/read-capped'

// Where a machine's service redeems its log-in (agent/src/node/enroll.rs
// `redeem_https`): `{code, code_verifier}` in, the machine's tunnel and the
// controller it pins out (api/wire.rs `EnrollRedeemed`).
//
// OUTSIDE the Pocket ID gate (authBypassRule in nix/stacks/daedalus/
// daedalus.nix): the caller is a root service with no browser behind it. It
// carries its own authorization — a single-use code an admin's Confirm minted
// minutes earlier, redeemed only with the PKCE verifier whose challenge the
// machine put in the page the admin confirmed (host/enroll.ts). A code seen on
// its way through the browser is useless without that verifier, and the first
// use spends it, right or wrong.

const NO_STORE = { 'cache-control': 'no-store' }

/** A redeem is two short strings; the cap is in bytes, enforced while reading. */
const MAX_BODY_BYTES = 4096

export const Route = createFileRoute('/api/agent/enroll')({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let bytes: Uint8Array | null
        try {
          bytes = await readCapped(request.body, MAX_BODY_BYTES)
        } catch {
          return Response.json(
            { error: 'the body could not be read' },
            { status: 400, headers: NO_STORE },
          )
        }
        if (bytes === null) {
          return Response.json(
            { error: 'the body is too large' },
            { status: 413, headers: NO_STORE },
          )
        }
        let body: unknown
        try {
          body = JSON.parse(new TextDecoder().decode(bytes))
        } catch {
          return Response.json(
            { error: 'the body is not JSON' },
            { status: 400, headers: NO_STORE },
          )
        }
        const { redeemEnroll } = await import('../host/enroll')
        const { wgEasy } = await import('../host/wg-easy')
        const wg = wgEasy()
        if (wg === null) {
          return Response.json(
            { error: 'this box cannot make tunnels yet' },
            { status: 503, headers: NO_STORE },
          )
        }
        const { enrollStore } = await import('../lib/repo/enroll')
        try {
          const a = await redeemEnroll({ store: enrollStore, wg }, body)
          return Response.json(a.body, { status: a.status, headers: NO_STORE })
        } catch (e) {
          // The message only: the answer being built carries a private key.
          console.warn(`enroll: redeem failed: ${e instanceof Error ? e.message : String(e)}`)
          return Response.json(
            { error: 'the log-in could not be redeemed' },
            { status: 500, headers: NO_STORE },
          )
        }
      },
    },
  },
})
