import { describe, expect, it } from 'vitest'
import { readCapped } from './read-capped'

const bytes = (n: number) => new Uint8Array(n).fill(0x61)

/** A body that never ends: each pull hands out another chunk. */
function endless(chunk: number) {
  let pulled = 0
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled += 1
      controller.enqueue(bytes(chunk))
    },
  })
  return { stream, pulled: () => pulled }
}

describe('readCapped', () => {
  it('hands back exactly the bytes, across chunks', async () => {
    const stream = new Request('http://x/', { method: 'POST', body: 'hello, world' }).body
    expect(new TextDecoder().decode((await readCapped(stream, 64)) ?? undefined)).toBe(
      'hello, world',
    )
  })

  it('reads an absent body as empty', async () => {
    expect(await readCapped(null, 8)).toEqual(new Uint8Array(0))
  })

  it('takes a body of exactly the cap', async () => {
    const stream = new Request('http://x/', { method: 'POST', body: bytes(4096) }).body
    expect((await readCapped(stream, 4096))?.byteLength).toBe(4096)
  })

  it('counts bytes, not characters', async () => {
    // 3000 characters, 6000 bytes: under a character count, over the cap.
    const stream = new Request('http://x/', { method: 'POST', body: 'é'.repeat(3000) }).body
    expect(await readCapped(stream, 4096)).toBeNull()
  })

  it('stops reading a body that never ends once it passes the cap', async () => {
    const body = endless(1024)
    expect(await readCapped(body.stream, 4096)).toBeNull()
    expect(body.pulled()).toBeLessThan(10)
  })
})
