import { createFileRoute } from '@tanstack/react-router'
import { makeCtx } from '../core/ctx'
import { profilePicture } from '../core/settings/profile'

// The signed-in person's Pocket ID picture, for Settings › Profile.
//
// Proxied rather than an <img> pointed at the IdP: the account is resolved from
// this request's forward-auth headers (core/settings/profile.ts), so the page
// never needs to know or send a user id, and a picture that was just replaced
// is revalidated here instead of served from what the browser kept of Pocket
// ID's origin. Behind the gate like every other path on this app — it is not in
// the forward-auth bypass, so the headers it reads are traefik's.
export const Route = createFileRoute('/api/profile-picture')({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const header = (name: string) => request.headers.get(name) || null
        const picture = await profilePicture(await makeCtx(), {
          sub: header('x-forwarded-user'),
          email: header('x-forwarded-email'),
        })
        // A plain 404, not the router's not-found: this answers an <img>.
        if (picture === null) return new Response(null, { status: 404 })
        return new Response(new Uint8Array(picture.bytes), {
          headers: {
            'content-type': picture.contentType,
            'cache-control': 'private, no-cache',
            'x-content-type-options': 'nosniff',
          },
        })
      },
    },
  },
})
