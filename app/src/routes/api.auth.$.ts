import { createFileRoute } from '@tanstack/react-router'
import { authEndpoint } from '../core/session'

// The sign-in's HTTP doors (core/session.ts `authEndpoint` lists them). A real
// route because the IdP redirects a browser here, which no server function can
// be, and open past the request gate's session check for the same reason.

export const Route = createFileRoute('/api/auth/$')({
  server: {
    handlers: { GET: ({ request }) => authEndpoint(request) },
  },
})
