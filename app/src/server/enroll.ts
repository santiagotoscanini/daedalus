import { getRequest, setResponseHeader } from '@tanstack/react-start/server'
import type { EnrollPage } from '../host/enroll'
import { asValidator, obj, withMessage } from '../lib/contract/decode'
import { strMax } from '../lib/contract/fields'
import { adminFn, readFn } from './fn'

// Server functions behind a Mac's log-in page (routes/agent.enroll.tsx;
// host/enroll.ts is the flow). The page's GET reads the request the browser
// made for the page itself — its query as sent, its Fetch Metadata — so it
// only ever answers for the document load the menu bar opened, never for a
// fetch the router makes later.

/**
 * The page, for the request it was loaded by. A read: the admin gate is inside
 * (host/enroll.ts `enrollPage`), before the form token is minted, so a viewer
 * who may not let a machine in is told so on the page.
 */
export const fetchEnrollPageFn = readFn.handler(async ({ context }): Promise<EnrollPage> => {
  const { enrollPage } = await import('../host/enroll')
  const { enrollStore } = await import('../lib/repo/enroll')
  const { wgEasy } = await import('../host/wg-easy')
  const ctx = await context.ctx()
  const request = getRequest()
  const url = new URL(request.url)
  const h = (n: string) => request.headers.get(n)
  // The page carries the log-in's state and challenge, and a token: kept by no
  // cache. (No Referrer-Policy of its own: the router's server-function calls
  // need the Referer, and the default already keeps the query from leaving
  // this origin.)
  try {
    setResponseHeader('cache-control', 'no-store')
  } catch {
    // Not a response of our own to set them on (a router fetch): nothing to keep.
  }
  const available = wgEasy() !== null && (ctx.env('WG_EASY_HOST_ALIAS') ?? '') !== ''
  let idpOrigin: string | null = null
  if (available) {
    try {
      idpOrigin = new URL(ctx.hosts.base('pocket-id')).origin
    } catch {
      idpOrigin = null
    }
  }
  return enrollPage(
    {
      path: url.pathname,
      search: url.search,
      site: h('sec-fetch-site'),
      mode: h('sec-fetch-mode'),
      dest: h('sec-fetch-dest'),
      referer: h('referer'),
    },
    {
      authorize: async () => {
        const { authorize, allow } = await import('../core/authz')
        return allow(await authorize())
      },
      available,
      idpOrigin,
      standing: enrollStore.standing,
    },
  )
})

/**
 * Confirm: the page's token, which names the machine the page showed. The
 * machine's loopback URL to go to, or why not with nothing changed.
 */
export const confirmEnrollFn = adminFn
  .validator(asValidator(withMessage(obj({ token: strMax(64) }), 'expected the page’s token')))
  .handler(async ({ data, context }) => {
    const { confirmEnroll } = await import('../host/enroll')
    const { enrollStore } = await import('../lib/repo/enroll')
    const { wgEasy } = await import('../host/wg-easy')
    const { syncDesired } = await import('../host/controller/nodes')
    const { siteIdentity } = await import('../host/contract/domains/site')
    const wg = wgEasy()
    if (wg === null) {
      return {
        ok: false as const,
        reason: 'This box cannot make tunnels yet.',
        retry: true as const,
      }
    }
    const ctx = await context.ctx()
    return confirmEnroll(
      {
        store: enrollStore,
        wg,
        systemInfo: () => ctx.controller.systemInfo(),
        sync: () => syncDesired(ctx),
        lanIp: (await siteIdentity()).data.lanIp,
        hostAlias: ctx.env('WG_EASY_HOST_ALIAS') ?? '',
        sessionHostPort: Number(ctx.env('SESSION_HOST_PORT')),
      },
      { token: data.token, actor: context.actor },
    )
  })
