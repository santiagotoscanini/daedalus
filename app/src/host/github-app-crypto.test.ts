import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { safeEqual, verifyWebhookSignature } from './github-app-crypto'

// GitHub's documented vector ("Validating webhook deliveries › Testing the
// webhook payload validation").
const SECRET = "It's a Secret to Everybody"
const TEXT = 'Hello, World!'
const PAYLOAD = new TextEncoder().encode(TEXT)
const DIGEST = '757107ea0eb2509fc211221cce984b8a37570b6d7586c22c46f4379c8b043e17'
const HEADER = `sha256=${DIGEST}`

const signedWith = (secret: string) =>
  `sha256=${createHmac('sha256', secret).update(PAYLOAD).digest('hex')}`

describe('verifyWebhookSignature', () => {
  it("accepts GitHub's documented vector, as bytes and as a Buffer", () => {
    expect(verifyWebhookSignature(PAYLOAD, HEADER, SECRET)).toBe(true)
    expect(verifyWebhookSignature(Buffer.from(TEXT), HEADER, SECRET)).toBe(true)
  })

  it('refuses a body that is not bytes, even one that would verify', () => {
    expect(verifyWebhookSignature(TEXT as never, HEADER, SECRET)).toBe(false)
    expect(verifyWebhookSignature(PAYLOAD.buffer as never, HEADER, SECRET)).toBe(false)
  })

  it('refuses a wrong signature, body or secret', () => {
    const flipped = `sha256=${DIGEST.slice(0, -1)}${DIGEST.endsWith('7') ? '8' : '7'}`
    expect(verifyWebhookSignature(PAYLOAD, flipped, SECRET)).toBe(false)
    expect(verifyWebhookSignature(new TextEncoder().encode(`${TEXT} `), HEADER, SECRET)).toBe(false)
    expect(verifyWebhookSignature(PAYLOAD, HEADER, 'another secret')).toBe(false)
  })

  it('requires the sha256= prefix', () => {
    expect(verifyWebhookSignature(PAYLOAD, DIGEST, SECRET)).toBe(false)
    expect(verifyWebhookSignature(PAYLOAD, `sha1=${DIGEST}`, SECRET)).toBe(false)
    expect(verifyWebhookSignature(PAYLOAD, `SHA256=${DIGEST}`, SECRET)).toBe(false)
  })

  it('refuses the wrong length and malformed hex', () => {
    expect(verifyWebhookSignature(PAYLOAD, 'sha256=00', SECRET)).toBe(false)
    expect(verifyWebhookSignature(PAYLOAD, 'sha256=', SECRET)).toBe(false)
    expect(verifyWebhookSignature(PAYLOAD, `sha256=${DIGEST.slice(2)}`, SECRET)).toBe(false)
    expect(verifyWebhookSignature(PAYLOAD, `${HEADER}00`, SECRET)).toBe(false)
    expect(verifyWebhookSignature(PAYLOAD, `${HEADER.slice(0, -1)}`, SECRET)).toBe(false)
    // Right length, but Buffer's hex decoder would stop at the 'z'.
    expect(verifyWebhookSignature(PAYLOAD, `sha256=${DIGEST.slice(0, 62)}zz`, SECRET)).toBe(false)
  })

  it('refuses a null header', () => {
    expect(verifyWebhookSignature(PAYLOAD, null, SECRET)).toBe(false)
  })

  // Each header is the correct HMAC for the secret beside it, so the secret's
  // shape is the only reason left to refuse.
  it.each([
    ['empty', ''],
    ['blank', '   '],
    ['a lone newline', '\n'],
    ['padded with a trailing newline', `${SECRET}\n`],
    ['padded with a leading space', ` ${SECRET}`],
    ['padded with a tab', `${SECRET}\t`],
  ])('refuses a secret that is %s, even with its own valid signature', (_label, secret) => {
    expect(verifyWebhookSignature(PAYLOAD, signedWith(secret), secret)).toBe(false)
  })
})

describe('safeEqual', () => {
  it('compares by content, including length', () => {
    expect(safeEqual('token', 'token')).toBe(true)
    expect(safeEqual('token', 'tokem')).toBe(false)
    expect(safeEqual('token', 'token2')).toBe(false)
    expect(safeEqual('', '')).toBe(true)
    expect(safeEqual('❯', '❯')).toBe(true)
  })
})
