import { describe, expect, it } from 'vitest'
import { deploymentState, pagesRow, pagesState, pagesWarnings } from './github-pages'

// The mapping from GitHub's `/repos/{o}/{r}/pages` answer to a row. Field
// names and values as GitHub's REST docs give them.

const NOW = Date.parse('2026-10-02T12:00:00Z')
const REPO = { fullName: 'santree-ai/santree', name: 'santree', description: 'A tree.' }

describe('pagesRow', () => {
  it('serves a custom domain at its CNAME', () => {
    const row = pagesRow(
      REPO,
      {
        html_url: 'https://santree.toscanini.me/',
        cname: 'Santree.toscanini.me',
        status: 'built',
        https_enforced: true,
        https_certificate: { state: 'approved', expires_at: '2026-12-01' },
      },
      { at: '2026-10-01T10:00:00Z', sha: 'abc1234def' },
      null,
      NOW,
    )
    expect(row).toEqual({
      id: 'santree-toscanini-me',
      name: 'santree',
      host: 'santree.toscanini.me',
      platform: 'GitHub Pages',
      description: 'A tree.',
      repo: 'santree-ai/santree',
      state: 'live',
      deployed: { at: '2026-10-01T10:00:00Z', sha: 'abc1234def' },
      warnings: [],
      dashboardUrl: 'https://github.com/santree-ai/santree/settings/pages',
    })
  })

  it('falls back to the github.io host when there is no CNAME', () => {
    const row = pagesRow(
      REPO,
      { html_url: 'https://santree-ai.github.io/santree/', status: null },
      null,
      null,
      NOW,
    )
    expect(row?.host).toBe('santree-ai.github.io')
    expect(row?.state).toBe('unknown')
  })

  it("reads a workflow site's state from its last deployment, /pages saying null", () => {
    const row = pagesRow(
      REPO,
      { html_url: 'https://santree.toscanini.me/', cname: 'santree.toscanini.me', status: null },
      { at: '2026-10-01T19:13:08Z', sha: '8a7d9a6' },
      'live',
      NOW,
    )
    expect(row?.state).toBe('live')
  })

  it('is null when GitHub gives no address at all', () => {
    expect(pagesRow(REPO, { status: 'built' }, null, null, NOW)).toBeNull()
  })
})

describe('pagesState', () => {
  it.each([
    ['built', 'live'],
    ['building', 'building'],
    ['errored', 'failed'],
    [null, 'unknown'],
  ])('%s → %s', (status, state) => {
    expect(pagesState(status)).toBe(state)
  })
})

describe('pagesWarnings', () => {
  it('names an unenforced HTTPS on a custom domain, and a certificate near expiry', () => {
    expect(
      pagesWarnings(
        {
          cname: 'docs.example.org',
          https_enforced: false,
          https_certificate: { state: 'approved', expires_at: '2026-10-09T00:00:00Z' },
        },
        NOW,
      ),
    ).toEqual(['HTTPS not enforced', 'certificate expires in 6 d'])
  })

  it('names a broken certificate and an expired one', () => {
    expect(
      pagesWarnings(
        {
          https_enforced: true,
          https_certificate: { state: 'bad_authz', expires_at: '2026-09-01' },
        },
        NOW,
      ),
    ).toEqual(['certificate bad authz', 'certificate expired'])
  })

  it('says nothing about a github.io site without enforced HTTPS', () => {
    expect(pagesWarnings({ cname: null, https_enforced: false }, NOW)).toEqual([])
  })
})

describe('deploymentState', () => {
  it.each([
    ['success', 'live'],
    ['in_progress', 'building'],
    ['queued', 'building'],
    ['failure', 'failed'],
    ['error', 'failed'],
    ['inactive', 'unknown'],
  ])('%s → %s', (s, state) => {
    expect(deploymentState(s)).toBe(state)
  })
})
