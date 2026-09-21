import { createElement } from 'react'
import { renderToString } from 'react-dom/server'
import { describe, expect, it } from 'vitest'
import { siteFrom } from './site'
import { SiteProvider, useSite } from './site-context'

function Host() {
  return createElement('code', null, `films.${useSite().baseDomain}`)
}

describe('useSite', () => {
  it('is in the server-rendered HTML — the value needs no effect to arrive', () => {
    const html = renderToString(
      SiteProvider({ site: siteFrom({ baseDomain: 'box.test' }), children: createElement(Host) }),
    )
    expect(html).toContain('films.box.test')
  })

  it('reads as unbound outside the provider, never as a box', () => {
    expect(renderToString(createElement(Host))).toContain('films.localhost')
  })
})
