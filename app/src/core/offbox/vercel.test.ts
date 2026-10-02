import { describe, expect, it } from 'vitest'
import { productionDomains, projectRepo, vercelRow, vercelState } from './vercel'

// The mapping from Vercel's `/v10/projects` answer to a row. Field names and
// values as Vercel's REST reference gives them.

const SCOPE = { teamId: 'team_1', slug: 'toscanini', name: 'Toscanini' }

const PROJECT = {
  id: 'prj_1',
  name: 'personal-portfolio',
  framework: 'nextjs',
  link: { type: 'github', org: 'santiagotoscanini', repo: 'personal-portfolio' },
  targets: {
    production: {
      readyState: 'READY',
      createdAt: Date.parse('2026-10-01T10:00:00Z'),
      alias: ['personal-portfolio.vercel.app', 'toscanini.me'],
      meta: { githubCommitSha: 'f00dfeed' },
    },
  },
  alias: [{ domain: 'www.toscanini.me', target: 'PRODUCTION' }],
}

describe('vercelRow', () => {
  it('serves a project at its first custom production domain', () => {
    expect(vercelRow(PROJECT, SCOPE, ['www.toscanini.me misconfigured'])).toEqual({
      id: 'toscanini-me',
      name: 'personal-portfolio',
      host: 'toscanini.me',
      platform: 'Vercel',
      description: null,
      repo: 'santiagotoscanini/personal-portfolio',
      state: 'live',
      deployed: { at: '2026-10-01T10:00:00.000Z', sha: 'f00dfeed' },
      warnings: ['www.toscanini.me misconfigured'],
      dashboardUrl: 'https://vercel.com/toscanini/personal-portfolio',
    })
  })

  it('falls back to <name>.vercel.app, and says when a project is paused', () => {
    const row = vercelRow({ id: 'prj_2', name: 'demo', paused: true }, SCOPE, [])
    expect(row?.host).toBe('demo.vercel.app')
    expect(row?.state).toBe('unknown')
    expect(row?.warnings).toEqual(['paused'])
    expect(row?.deployed).toBeNull()
  })

  it('is null for a project without an id or a name', () => {
    expect(vercelRow({ name: 'x' }, SCOPE, [])).toBeNull()
  })
})

describe('productionDomains', () => {
  it('puts custom domains before vercel.app ones, each once', () => {
    expect(productionDomains(PROJECT)).toEqual([
      'toscanini.me',
      'www.toscanini.me',
      'personal-portfolio.vercel.app',
    ])
  })
})

describe('projectRepo', () => {
  it('names a GitHub-linked repo, and nothing else', () => {
    expect(projectRepo(PROJECT)).toBe('santiagotoscanini/personal-portfolio')
    expect(projectRepo({ link: { type: 'gitlab', org: 'a', repo: 'b' } })).toBeNull()
  })
})

describe('vercelState', () => {
  it.each([
    ['READY', 'live'],
    ['BUILDING', 'building'],
    ['QUEUED', 'building'],
    ['ERROR', 'failed'],
    ['CANCELED', 'failed'],
    [undefined, 'unknown'],
  ])('%s → %s', (s, state) => {
    expect(vercelState(s)).toBe(state)
  })
})
