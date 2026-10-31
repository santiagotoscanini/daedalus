import { afterEach, describe, expect, it, vi } from 'vitest'
import { contentSecurityPolicy, securityHeaders, withSecurityHeaders } from './security-headers'

afterEach(() => {
  vi.unstubAllEnvs()
})

const directive = (csp: string, name: string) =>
  csp.split('; ').find((d) => d.startsWith(`${name} `))

describe('the content security policy', () => {
  it('lets nothing frame the app, and nothing rewrite where its links go', () => {
    const csp = contentSecurityPolicy(undefined)
    expect(directive(csp, 'frame-ancestors')).toBe("frame-ancestors 'none'")
    expect(directive(csp, 'base-uri')).toBe("base-uri 'self'")
    expect(directive(csp, 'object-src')).toBe("object-src 'none'")
  })

  it('keeps scripts and connections to this origin', () => {
    const csp = contentSecurityPolicy(undefined)
    expect(directive(csp, 'script-src')).toBe("script-src 'self' 'unsafe-inline'")
    expect(directive(csp, 'connect-src')).toBe("connect-src 'self'")
  })

  it('allows the one form that leaves: the GitHub App manifest', () => {
    expect(directive(contentSecurityPolicy(undefined), 'form-action')).toBe(
      "form-action 'self' https://github.com",
    )
  })

  it('names Grafana for its embeds, by origin alone', () => {
    const csp = contentSecurityPolicy('https://grafana.example.test/d/abc?x=1')
    expect(directive(csp, 'frame-src')).toBe("frame-src 'self' https://grafana.example.test")
  })

  it('embeds only itself on a box without Grafana', () => {
    expect(directive(contentSecurityPolicy(''), 'frame-src')).toBe("frame-src 'self'")
  })
})

describe('the headers on a response', () => {
  it('reach every response, redirects included', () => {
    for (const r of [new Response('ok'), Response.redirect('https://example.test/', 302)]) {
      const headed = withSecurityHeaders(r)
      expect(headed.status).toBe(r.status)
      for (const name of Object.keys(securityHeaders(undefined))) {
        expect(headed.headers.has(name), name).toBe(true)
      }
    }
  })

  it('keep what the response already said', () => {
    const r = new Response('ok', { status: 201, headers: { 'set-cookie': 'a=b', etag: 'x' } })
    const headed = withSecurityHeaders(r)
    expect(headed.status).toBe(201)
    expect(headed.headers.get('etag')).toBe('x')
    expect(headed.headers.getSetCookie()).toEqual(['a=b'])
  })
})
