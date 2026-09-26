import { describe, expect, it } from 'vitest'
import { cell, code, deployStatus, dropHead } from './build-report-text'

// The Markdown helpers the check run leans on. summaryOf, titleOf, fenceLog,
// matchDeploy and deliveryOf are covered through core/builds/report*.test.ts.

describe('code', () => {
  it('fences past every backtick run, padding a value that starts or ends with one', () => {
    expect(code('lint')).toBe('`lint`')
    expect(code('a`b')).toBe('``a`b``')
    expect(code('`x`')).toBe('`` `x` ``')
  })
})

describe('cell', () => {
  it('escapes pipes and folds whitespace, newlines included', () => {
    expect(cell(' a | b\n c ')).toBe('a \\| b c')
  })
})

describe('dropHead', () => {
  it('drops to the next whole line', () => {
    expect(dropHead('one\ntwo\nthree', 2)).toBe('two\nthree')
  })

  it('never splits a multi-byte character when there is no newline', () => {
    // 'é' is two bytes: dropping one must skip the continuation byte too.
    expect(dropHead('éa', 1)).toBe('a')
  })
})

describe('deployStatus', () => {
  const base = { digest: 'd', revision: null, startedAt: new Date(0) }

  it('reads ok as success, with the HTTP code or the no-ingress note', () => {
    expect(deployStatus({ ...base, result: 'ok', httpCode: '200' })).toEqual({
      state: 'success',
      description: 'Deployed and answering (HTTP 200).',
    })
    expect(deployStatus({ ...base, result: 'ok', httpCode: 'unverified' }).description).toBe(
      'Deployed. Not health-checked: the app has no ingress.',
    )
  })

  it('reads anything else as failure, the image still running', () => {
    expect(deployStatus({ ...base, result: 'failed', httpCode: null })).toEqual({
      state: 'failure',
      description: 'Deployed, but the health check failed. The new image is still running.',
    })
  })
})
