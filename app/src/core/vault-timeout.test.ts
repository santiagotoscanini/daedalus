import type { EventEmitter } from 'node:events'
import type { PassThrough } from 'node:stream'
import { afterEach, describe, expect, it, vi } from 'vitest'

// The sops kill timer, against a fake child: a sops that never exits is
// killed with SIGKILL at SOPS_TIMEOUT_MS and the seal fails with "sops timed
// out"; one that answers in time is left alone.

type FakeChild = EventEmitter & {
  stdout: PassThrough
  stderr: PassThrough
  stdin: PassThrough
  kill: ReturnType<typeof vi.fn>
}

const h = vi.hoisted(() => ({ children: [] as unknown[] }))

vi.mock('node:child_process', async () => {
  const { EventEmitter: Emitter } = await import('node:events')
  const { PassThrough: Pipe } = await import('node:stream')
  return {
    spawn: () => {
      const child = Object.assign(new Emitter(), {
        stdout: new Pipe(),
        stderr: new Pipe(),
        stdin: new Pipe(),
        kill: vi.fn(() => {
          child.emit('close', null, 'SIGKILL')
          return true
        }),
      })
      h.children.push(child)
      return child
    },
  }
})

const { SOPS_TIMEOUT_MS, sealForVault } = await import('./vault')

const FILE = 'vault/cloudflare-api-token.sops'
const VALUE = 'a-token-value-only-for-the-timeout-test'
const SOPS_FILE = JSON.stringify({
  data: 'ENC[AES256_GCM,data:abc,iv:def,tag:ghi,type:str]',
  sops: { age: [{ recipient: 'age1example' }], mac: 'ENC[AES256_GCM,data:mac,type:str]' },
})

const lastChild = () => h.children.at(-1) as FakeChild

afterEach(() => {
  vi.useRealTimers()
  h.children = []
})

describe('the sops kill timer', () => {
  it('kills a sops that never exits and says so', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sealing = sealForVault(FILE, VALUE)
    const child = lastChild()

    await vi.advanceTimersByTimeAsync(SOPS_TIMEOUT_MS - 1)
    expect(child.kill).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)
    await expect(sealing).resolves.toEqual({ ok: false, reason: 'sops timed out' })
    expect(child.kill).toHaveBeenCalledWith('SIGKILL')
    expect(SOPS_TIMEOUT_MS).toBe(30_000)
  })

  it('leaves a sops that answers in time alone', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const sealing = sealForVault(FILE, VALUE)
    const child = lastChild()

    const read = new Promise((resolve) => child.stdout.once('data', resolve))
    child.stdout.write(SOPS_FILE)
    await read
    child.emit('close', 0)

    await expect(sealing).resolves.toEqual({ ok: true, ciphertext: SOPS_FILE })
    await vi.advanceTimersByTimeAsync(SOPS_TIMEOUT_MS * 2)
    expect(child.kill).not.toHaveBeenCalled()
  })
})
