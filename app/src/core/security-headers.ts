import { env } from '../host/env'

// What every answer of this app tells the browser, set once around the whole
// server (src/server.ts). Traefik adds HSTS, nosniff and the referrer policy on
// its side; these are the ones only this app can write, because they name what
// it loads.
//
// The Content-Security-Policy is one a person can read against the app:
//
//   'unsafe-inline' for scripts: the framework streams inline scripts into
//                    every page and the theme boots from one, and a nonce would
//                    have to reach all of them per request. So this does not
//                    stop an injected inline script from RUNNING. What it stops
//                    is that script doing much: it cannot load more code, and
//                    `connect-src` and `form-action` close the plain ways out.
//   img-src https:   release notes and a few pages show remote images.
//   frame-src        Grafana, which two pages embed.
//   form-action      GitHub, where the App's manifest form posts.
//   frame-ancestors  nobody may frame a page that can rebuild the box.

export function contentSecurityPolicy(grafanaUrl: string | undefined): string {
  const grafana =
    grafanaUrl === undefined || grafanaUrl === '' ? '' : ` ${new URL(grafanaUrl).origin}`
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: blob: https:",
    "font-src 'self' data:",
    "connect-src 'self'",
    `frame-src 'self'${grafana}`,
    "frame-ancestors 'none'",
    "form-action 'self' https://github.com",
    "base-uri 'self'",
    "object-src 'none'",
  ].join('; ')
}

/** The headers, by name. */
export const securityHeaders = (grafanaUrl: string | undefined): Record<string, string> => ({
  'content-security-policy': contentSecurityPolicy(grafanaUrl),
  // For a browser that predates `frame-ancestors`.
  'x-frame-options': 'DENY',
  // A page this app opens cannot reach back into it through window.opener.
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-resource-policy': 'same-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
})

/** A response carrying them. A copy, because some Responses have immutable headers. */
export function withSecurityHeaders(response: Response): Response {
  const headed = new Response(response.body, response)
  for (const [name, value] of Object.entries(securityHeaders(env.get('GRAFANA_URL')))) {
    headed.headers.set(name, value)
  }
  return headed
}
