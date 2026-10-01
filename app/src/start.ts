import { createCsrfMiddleware, createMiddleware, createStart } from '@tanstack/react-start'

// The request middleware every request passes through, in order.
//
// 1. The request gate (core/request-gate.ts): traefik's proof, an exempt door,
//    or the reader token — for pages, server functions and `api.*` routes
//    alike. Reached with `await import`, like every server-only module from a
//    file the client also loads (host/boundary.test.ts).
// 2. TanStack Start's CSRF check on server functions, which declaring a start
//    instance at all would otherwise drop (server/fn.test.ts says why it
//    matters).

const requestGate = createMiddleware().server(async ({ request, next }) => {
  const { gate } = await import('./core/request-gate')
  return gate(request) ?? next()
})

const csrf = createCsrfMiddleware({ filter: (ctx) => ctx.handlerType === 'serverFn' })

export const startInstance = createStart(() => ({ requestMiddleware: [requestGate, csrf] }))
