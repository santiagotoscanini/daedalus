import { describe, expect, it } from 'vitest'
import { tokenShapeError } from './cloudflare-token'

const TOKEN = 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9cE1gI3kM5oQ7s'

describe('tokenShapeError', () => {
  it('takes both token formats Cloudflare issues and refuses anything else', () => {
    expect(tokenShapeError(TOKEN)).toBeNull()
    expect(tokenShapeError(`  ${TOKEN}\n`)).toBeNull()
    expect(tokenShapeError(`cfat_${'x'.repeat(48)}`)).toBeNull()
    expect(tokenShapeError('')).not.toBeNull()
    expect(tokenShapeError('abc def')).not.toBeNull()
    expect(tokenShapeError('short')).not.toBeNull()
  })
})
