// object-store.test.ts — the contract of object-store.ts, for every app.
//
// CANONICAL COPY: daedalus's nix/modules/garage/client/object-store.test.ts. It
// travels with object-store.ts, VERBATIM, to src/server/object-store.test.ts in
// every app with Object storage. Change it here and re-copy; an app's own tests
// of what it builds on `ObjectStore` live in the app's own files.
//
// One contract, two drivers. The S3 driver runs on a real S3Client whose `send`
// is a fake that answers in S3's shapes (errors by name and status, a Body with
// the SDK's transform methods, list pages with continuation tokens, multipart)
// from a memory store behind it, so no test touches a network. What is checked
// is the driver's translation: a missing key is null and nothing else is, one
// range goes through and comes back as a 206, every write names its type, a
// failed delete is an error, a listing follows every page, a copy onto itself
// keeps its metadata, a big file goes in parts, and a broken download leaves no
// file behind.

import { createHash } from 'node:crypto'
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Readable } from 'node:stream'
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CopyObjectCommand,
  CreateMultipartUploadCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3'
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest'
import {
  MULTIPART_THRESHOLD,
  RangeNotSatisfiable,
  memoryObjectStore,
  objectResponse,
  objectStoreFromEnv,
  s3ConfigFromEnv,
  s3ObjectStore,
  type Bytes,
  type ObjectStore,
  type StoredObject,
} from './object-store'

const bytes = (...values: number[]) => new Uint8Array(values)
const TEN = bytes(0, 1, 2, 3, 4, 5, 6, 7, 8, 9)
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')

let dir = ''
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'object-store-'))
})
afterAll(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** A fresh directory under the test's temp dir. */
const scratch = async () => mkdtemp(join(dir, 'case-'))

async function bodyBytes(obj: StoredObject): Promise<number[]> {
  const body =
    obj.body instanceof Uint8Array
      ? obj.body
      : new Uint8Array(await new Response(obj.body).arrayBuffer())
  return [...body]
}

async function collect(body: unknown): Promise<Bytes> {
  if (body instanceof Uint8Array) return new Uint8Array(body)
  if (body instanceof Readable) {
    const chunks: Buffer[] = []
    for await (const chunk of body) chunks.push(Buffer.from(chunk as Uint8Array))
    return new Uint8Array(Buffer.concat(chunks))
  }
  throw new Error(`unexpected body: ${typeof body}`)
}

const s3Error = (name: string, status: number) =>
  Object.assign(new Error(name), { name, $metadata: { httpStatusCode: status } })

/** What the SDK throws when no answer came: a `$metadata` with no status in it. */
const refused = () =>
  Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:3900'), {
    code: 'ECONNREFUSED',
    $metadata: { attempts: 1, totalRetryDelay: 0 },
  })

/** The handler's own requestTimeout: the store took the request and sat on it. */
const satOn = () =>
  Object.assign(
    new Error(
      '@smithy/node-http-handler - [ERROR] a request has exceeded the configured 15000 ms requestTimeout.',
    ),
    { name: 'TimeoutError', code: 'ETIMEDOUT', $metadata: { attempts: 1, totalRetryDelay: 0 } },
  )

/** A body that sends three bytes and then breaks, like a connection reset mid-download. */
const brokenStream = (data: Bytes) =>
  new Readable({
    read() {
      this.push(data.subarray(0, 3))
      this.destroy(new Error('connection reset'))
    },
  })

interface FakeOptions {
  /** Every GetObject fails with this S3 error. */
  failGets?: { name: string; status: number }
  /** DeleteObjects reports every key as not deleted. */
  failDeletes?: boolean
  /** Keys per ListObjectsV2 page. */
  pageSize?: number
  /** GetObject's body breaks after three bytes. */
  brokenBody?: boolean
  /**
   * The first `times` sends of `kind` get no answer (`error`, by default a
   * refused connection), after reading their body when `consume` is set: a
   * reset mid-upload.
   */
  drop?: {
    kind: new (...args: never[]) => object
    times: number
    consume?: boolean
    error?: () => Error
  }
}

/** S3 in memory: a real client whose `send` answers like Garage, recording every command. */
function fakeS3(options: FakeOptions = {}) {
  const backing = memoryObjectStore()
  const cacheControl = new Map<string, string | undefined>()
  const uploads = new Map<string, { key: string; type: string; parts: Map<number, Bytes> }>()
  const sent: object[] = []
  let dropped = 0

  async function send(cmd: object): Promise<unknown> {
    sent.push(cmd)
    const { drop } = options
    if (drop && cmd instanceof drop.kind && dropped < drop.times) {
      dropped++
      if (drop.consume) await collect((cmd as { input: { Body?: unknown } }).input.Body)
      throw (drop.error ?? refused)()
    }
    if (cmd instanceof PutObjectCommand) {
      const { Key, Body, ContentType, CacheControl } = cmd.input
      cacheControl.set(Key!, CacheControl)
      const { etag } = await backing.put(Key!, await collect(Body), ContentType ?? '')
      return { ETag: etag }
    }
    if (cmd instanceof GetObjectCommand) {
      if (options.failGets) throw s3Error(options.failGets.name, options.failGets.status)
      let obj: StoredObject | null
      try {
        obj = await backing.open(cmd.input.Key!, cmd.input.Range)
      } catch (err) {
        if (err instanceof RangeNotSatisfiable) throw s3Error('InvalidRange', 416)
        throw err
      }
      if (!obj) throw s3Error('NoSuchKey', 404)
      const data = obj.body as Bytes
      const stream = options.brokenBody ? brokenStream(data) : Readable.from([data])
      return {
        Body: Object.assign(stream, {
          transformToByteArray: async () => data,
          transformToWebStream: () => new Blob([data]).stream(),
        }),
        ContentType: obj.contentType,
        ContentLength: obj.contentLength,
        ETag: obj.etag,
        ContentRange: obj.contentRange ?? undefined,
      }
    }
    if (cmd instanceof HeadObjectCommand) {
      const key = cmd.input.Key!
      const info = await backing.head(key)
      if (!info) throw s3Error('NotFound', 404) // a HEAD has no body to name the error
      return {
        ContentLength: info.size,
        ETag: info.etag,
        LastModified: info.lastModified,
        ContentType: (await backing.open(key))!.contentType,
        CacheControl: cacheControl.get(key),
        Metadata: {},
      }
    }
    if (cmd instanceof ListObjectsV2Command) {
      const all = []
      for await (const o of backing.list(cmd.input.Prefix ?? '')) all.push(o)
      const start = Number(cmd.input.ContinuationToken ?? 0)
      const size = options.pageSize ?? 1000
      const next = start + size < all.length ? String(start + size) : undefined
      return {
        Contents: all.slice(start, start + size).map((o) => ({
          Key: o.key,
          Size: o.size,
          ETag: o.etag,
          LastModified: o.lastModified,
        })),
        IsTruncated: next !== undefined,
        NextContinuationToken: next,
      }
    }
    if (cmd instanceof CopyObjectCommand) {
      const [, ...segments] = cmd.input.CopySource!.split('/')
      const from = segments.map(decodeURIComponent).join('/')
      const data = await backing.read(from)
      if (!data) throw s3Error('NoSuchKey', 404)
      // Garage: REPLACE takes the metadata from the request, COPY from the source.
      const replace = cmd.input.MetadataDirective === 'REPLACE'
      const type = replace ? (cmd.input.ContentType ?? '') : (await backing.open(from))!.contentType
      cacheControl.set(cmd.input.Key!, replace ? cmd.input.CacheControl : cacheControl.get(from))
      await backing.put(cmd.input.Key!, data, type)
      return {}
    }
    if (cmd instanceof DeleteObjectsCommand) {
      const keys = cmd.input.Delete!.Objects!.map((o) => o.Key!)
      if (options.failDeletes)
        return { Errors: keys.map((Key) => ({ Key, Code: 'InternalError' })) }
      await backing.remove(keys)
      return {}
    }
    if (cmd instanceof CreateMultipartUploadCommand) {
      const id = `upload-${uploads.size + 1}`
      uploads.set(id, { key: cmd.input.Key!, type: cmd.input.ContentType ?? '', parts: new Map() })
      cacheControl.set(cmd.input.Key!, cmd.input.CacheControl)
      return { UploadId: id, Bucket: cmd.input.Bucket, Key: cmd.input.Key }
    }
    if (cmd instanceof UploadPartCommand) {
      const upload = uploads.get(cmd.input.UploadId!)!
      upload.parts.set(cmd.input.PartNumber!, await collect(cmd.input.Body))
      return { ETag: `"part-${cmd.input.PartNumber}"` }
    }
    if (cmd instanceof CompleteMultipartUploadCommand) {
      const upload = uploads.get(cmd.input.UploadId!)!
      const parts = cmd.input.MultipartUpload!.Parts!.map((p) => upload.parts.get(p.PartNumber!)!)
      const { etag } = await backing.put(
        upload.key,
        new Uint8Array(Buffer.concat(parts)),
        upload.type,
      )
      uploads.delete(cmd.input.UploadId!)
      return { ETag: etag, Bucket: cmd.input.Bucket, Key: upload.key }
    }
    if (cmd instanceof AbortMultipartUploadCommand) {
      uploads.delete(cmd.input.UploadId!)
      return {}
    }
    throw new Error(`the fake does not answer ${cmd.constructor.name}`)
  }

  const client = new S3Client({
    endpoint: 'http://127.0.0.1:9',
    region: 'garage',
    forcePathStyle: true,
    credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
  })
  client.send = send
  return { store: s3ObjectStore(client, 'bucket'), sent, uploads }
}

/** The commands of one kind, in the order they were sent. */
const sentOf = <T extends object>(sent: object[], kind: new (...args: never[]) => T): T[] =>
  sent.filter((c): c is T => c instanceof kind)

const drivers: [string, () => ObjectStore][] = [
  ['memory', () => memoryObjectStore()],
  ['s3', () => fakeS3().store],
]

describe.each(drivers)('the %s driver', (_, make) => {
  test('keeps what was put, with its type and an ETag', async () => {
    const store = make()
    const { etag } = await store.put('speech/ab/abc.mp3', TEN, 'audio/mpeg')
    expect(etag).toBeTruthy()
    expect(await store.read('speech/ab/abc.mp3')).toEqual(TEN)

    const obj = (await store.open('speech/ab/abc.mp3'))!
    expect(obj.contentType).toBe('audio/mpeg')
    expect(obj.contentLength).toBe(10)
    expect(obj.etag).toBe(etag)
    expect(obj.contentRange).toBeNull()
    expect(await bodyBytes(obj)).toEqual([...TEN])

    const info = (await store.head('speech/ab/abc.mp3'))!
    expect(info).toMatchObject({ key: 'speech/ab/abc.mp3', size: 10, etag })
    expect(info.lastModified).toBeInstanceOf(Date)
  })

  test('a missing key is null, not an error', async () => {
    const store = make()
    const out = join(await scratch(), 'clip.wav')
    expect(await store.read('voices/u/v-es.wav')).toBeNull()
    expect(await store.open('voices/u/v-es.wav')).toBeNull()
    expect(await store.head('voices/u/v-es.wav')).toBeNull()
    expect(await store.readToFile('voices/u/v-es.wav', out)).toBe(false)
    await expect(readFile(out)).rejects.toThrow()
  })

  test('one range comes back as that range', async () => {
    const store = make()
    await store.put('k', TEN, 'audio/wav')
    const mid = (await store.open('k', 'bytes=2-5'))!
    expect(mid.contentRange).toBe('bytes 2-5/10')
    expect(mid.contentLength).toBe(4)
    expect(await bodyBytes(mid)).toEqual([2, 3, 4, 5])

    const tail = (await store.open('k', 'bytes=-3'))!
    expect(tail.contentRange).toBe('bytes 7-9/10')
    expect(await bodyBytes(tail)).toEqual([7, 8, 9])

    const rest = (await store.open('k', 'bytes=8-'))!
    expect(await bodyBytes(rest)).toEqual([8, 9])
  })

  test('a range past the end is unsatisfiable, and two ranges get the whole object', async () => {
    const store = make()
    await store.put('k', TEN, 'audio/wav')
    await expect(store.open('k', 'bytes=10-12')).rejects.toBeInstanceOf(RangeNotSatisfiable)
    const whole = (await store.open('k', 'bytes=0-1,4-5'))!
    expect(whole.contentRange).toBeNull()
    expect(await bodyBytes(whole)).toEqual([...TEN])
  })

  test('remove deletes, and a key that is not there is already deleted', async () => {
    const store = make()
    await store.put('a', TEN, 'audio/mpeg')
    await store.remove(['a', 'never-there'])
    await store.remove([])
    expect(await store.read('a')).toBeNull()
  })

  test('list walks one prefix, in key order', async () => {
    const store = make()
    for (const key of ['b/2', 'a/1', 'b/1', 'b/10', 'c']) await store.put(key, TEN, 'text/plain')
    const found = []
    for await (const o of store.list('b/')) found.push(o)
    expect(found.map((o) => o.key)).toEqual(['b/1', 'b/10', 'b/2'])
    expect(found.every((o) => o.size === 10 && o.lastModified instanceof Date)).toBe(true)
  })

  test('copy keeps the bytes and the type; onto itself it moves only the time', async () => {
    const store = make()
    vi.useFakeTimers({ toFake: ['Date'] })
    try {
      vi.setSystemTime(new Date('2026-01-01T00:00:00Z'))
      await store.put('a', TEN, 'audio/mpeg')
      await store.copy('a', 'b')
      expect(await store.read('b')).toEqual(TEN)
      expect((await store.open('b'))!.contentType).toBe('audio/mpeg')

      vi.setSystemTime(new Date('2026-01-02T00:00:00Z'))
      await store.copy('a', 'a')
      expect((await store.head('a'))!.lastModified).toEqual(new Date('2026-01-02T00:00:00Z'))
      expect((await store.open('a'))!.contentType).toBe('audio/mpeg')
      expect(await store.read('a')).toEqual(TEN)
    } finally {
      vi.useRealTimers()
    }
    await expect(store.copy('never-there', 'x')).rejects.toThrow()
  })

  test('putFile stores a file, and readToFile writes one back whole', async () => {
    const store = make()
    const work = await scratch()
    const src = join(work, 'in.bin')
    const data = new Uint8Array(4096).map((_, i) => i % 251)
    await writeFile(src, data)

    await store.putFile('files/in.bin', src, 'application/octet-stream')
    expect(await store.read('files/in.bin')).toEqual(data)

    const out = join(work, 'out', 'nested', 'copy.bin')
    expect(await store.readToFile('files/in.bin', out)).toBe(true)
    expect(new Uint8Array(await readFile(out))).toEqual(data)
    expect((await readdir(join(work, 'out', 'nested'))).filter((f) => f.endsWith('.part'))).toEqual(
      [],
    )
  })
})

describe('the s3 driver, on the wire', () => {
  test('every PUT names its type and length, and its cache policy when given', async () => {
    const { store, sent } = fakeS3()
    await store.put('voices/u/v-en.wav', TEN, 'audio/wav')
    await store.put('speech/ab/abc.mp3', TEN, 'audio/mpeg', { cacheControl: 'public, max-age=60' })
    const [plain, cached] = sentOf(sent, PutObjectCommand)
    expect(plain!.input).toMatchObject({
      Bucket: 'bucket',
      Key: 'voices/u/v-en.wav',
      ContentType: 'audio/wav',
    })
    expect(plain!.input.ContentLength).toBe(10)
    expect(plain!.input.CacheControl).toBeUndefined()
    expect(cached!.input.CacheControl).toBe('public, max-age=60')
  })

  test('deletes go 1000 keys at a time, quietly', async () => {
    const { store, sent } = fakeS3()
    const keys = Array.from({ length: 2500 }, (_, i) => `speech/00/${i}.mp3`)
    await store.remove(keys)
    const batches = sentOf(sent, DeleteObjectsCommand).map((c) => c.input.Delete!)
    expect(batches.map((d) => d.Objects!.length)).toEqual([1000, 1000, 500])
    expect(batches.every((d) => d.Quiet)).toBe(true)
  })

  test('a delete the store refused is an error', async () => {
    const { store } = fakeS3({ failDeletes: true })
    await expect(store.remove(['a', 'b'])).rejects.toThrow(/2 of 2 objects were not deleted/)
  })

  test('any other failure is thrown, never read as a missing object', async () => {
    const denied = fakeS3({ failGets: { name: 'AccessDenied', status: 403 } }).store
    await expect(denied.read('a')).rejects.toThrow('AccessDenied')
    await expect(denied.open('a')).rejects.toThrow('AccessDenied')
    await expect(denied.readToFile('a', join(await scratch(), 'a'))).rejects.toThrow('AccessDenied')

    // A 404 that is not about the key: the bucket itself is gone.
    const gone = fakeS3({ failGets: { name: 'NoSuchBucket', status: 404 } }).store
    await expect(gone.read('a')).rejects.toThrow('NoSuchBucket')
  })

  test('list follows the continuation token to the last page', async () => {
    const { store, sent } = fakeS3({ pageSize: 2 })
    for (const key of ['p/1', 'p/2', 'p/3', 'p/4', 'p/5', 'q/1'])
      await store.put(key, TEN, 'text/plain')
    const found = []
    for await (const o of store.list('p/')) found.push(o.key)
    expect(found).toEqual(['p/1', 'p/2', 'p/3', 'p/4', 'p/5'])
    const pages = sentOf(sent, ListObjectsV2Command).map((c) => c.input)
    expect(pages.map((p) => p.ContinuationToken)).toEqual([undefined, '2', '4'])
    expect(pages.every((p) => p.Prefix === 'p/' && p.Bucket === 'bucket')).toBe(true)
  })

  test('copy onto itself REPLACEs with the metadata the object already has', async () => {
    const { store, sent } = fakeS3()
    await store.put('a b/c.mp3', TEN, 'audio/mpeg', {
      cacheControl: 'private, max-age=31536000, immutable',
    })
    await store.copy('a b/c.mp3', 'a b/c.mp3')
    await store.copy('a b/c.mp3', 'elsewhere.mp3')
    const [self, other] = sentOf(sent, CopyObjectCommand).map((c) => c.input)
    expect(self).toMatchObject({
      Bucket: 'bucket',
      Key: 'a b/c.mp3',
      CopySource: 'bucket/a%20b/c.mp3',
      MetadataDirective: 'REPLACE',
      ContentType: 'audio/mpeg',
      CacheControl: 'private, max-age=31536000, immutable',
    })
    expect(other).toMatchObject({ Key: 'elsewhere.mp3', CopySource: 'bucket/a%20b/c.mp3' })
    expect(other!.MetadataDirective).toBeUndefined()
  })

  test('putFile up to the threshold is one PUT of the file', async () => {
    const { store, sent } = fakeS3()
    const src = join(await scratch(), 'small.bin')
    await writeFile(src, new Uint8Array(1024).fill(7))
    await store.putFile('small.bin', src, 'application/octet-stream', { cacheControl: 'no-store' })
    const puts = sentOf(sent, PutObjectCommand)
    expect(puts).toHaveLength(1)
    expect(puts[0]!.input).toMatchObject({
      ContentLength: 1024,
      ContentType: 'application/octet-stream',
    })
    expect(puts[0]!.input.CacheControl).toBe('no-store')
    expect(sentOf(sent, CreateMultipartUploadCommand)).toHaveLength(0)
  })

  test('putFile past the threshold goes in parts and arrives whole', async () => {
    const { store, sent, uploads } = fakeS3()
    const src = join(await scratch(), 'big.bin')
    const data = new Uint8Array(MULTIPART_THRESHOLD + 1)
    for (let i = 0; i < data.length; i += 4096) data[i] = (i / 4096) % 256
    await writeFile(src, data)

    const { etag } = await store.putFile('big.bin', src, 'video/mp4')
    expect(etag).toBeTruthy()
    expect(sentOf(sent, PutObjectCommand)).toHaveLength(0)
    const [create] = sentOf(sent, CreateMultipartUploadCommand)
    expect(create!.input).toMatchObject({
      Bucket: 'bucket',
      Key: 'big.bin',
      ContentType: 'video/mp4',
    })
    // Parts go up concurrently, so in no fixed order.
    expect(
      sentOf(sent, UploadPartCommand)
        .map((c) => c.input.PartNumber)
        .sort(),
    ).toEqual([1, 2])
    expect(sentOf(sent, CompleteMultipartUploadCommand)).toHaveLength(1)
    expect(uploads.size).toBe(0)

    const stored = (await store.read('big.bin'))!
    expect(stored.length).toBe(data.length)
    expect(sha(stored)).toBe(sha(data))
    expect((await store.open('big.bin'))!.contentType).toBe('video/mp4')
  })

  test('readToFile leaves nothing behind when the body breaks', async () => {
    const work = await scratch()
    const broken = fakeS3({ brokenBody: true }).store
    await broken.put('a', TEN, 'audio/mpeg')
    await expect(broken.readToFile('a', join(work, 'a.mp3'))).rejects.toThrow('connection reset')
    expect(await readdir(work)).toEqual([])
  })
})

describe('the s3 driver, when the store does not answer', () => {
  test('a request that got no answer is tried again, four attempts in all', async () => {
    const { store, sent } = fakeS3({ drop: { kind: PutObjectCommand, times: 3 } })
    await store.put('a', TEN, 'audio/mpeg')
    expect(sentOf(sent, PutObjectCommand)).toHaveLength(4)
    expect(await store.read('a')).toEqual(TEN)

    const dead = fakeS3({ drop: { kind: GetObjectCommand, times: 99 } })
    await expect(dead.store.read('a')).rejects.toThrow('ECONNREFUSED')
    expect(sentOf(dead.sent, GetObjectCommand)).toHaveLength(4)
  })

  test('an answer is never retried, a 500 included', async () => {
    const { store, sent } = fakeS3({ failGets: { name: 'InternalError', status: 500 } })
    await expect(store.read('a')).rejects.toThrow('InternalError')
    expect(sentOf(sent, GetObjectCommand)).toHaveLength(1)
  })

  test('nor is a request the store sat on past requestTimeout', async () => {
    const { store, sent } = fakeS3({ drop: { kind: HeadObjectCommand, times: 99, error: satOn } })
    await expect(store.head('a')).rejects.toThrow('requestTimeout')
    expect(sentOf(sent, HeadObjectCommand)).toHaveLength(1)
  })

  test('putFile opens the file again for each attempt', async () => {
    const src = join(await scratch(), 'clip.wav')
    const data = new Uint8Array(2048).map((_, i) => i % 199)
    await writeFile(src, data)
    // The first attempt reads the whole stream, then the connection resets.
    const { store, sent } = fakeS3({ drop: { kind: PutObjectCommand, times: 1, consume: true } })
    await store.putFile('clip.wav', src, 'audio/wav')
    const [first, second] = sentOf(sent, PutObjectCommand)
    expect(second!.input.Body).not.toBe(first!.input.Body)
    expect(await store.read('clip.wav')).toEqual(data)
  })

  test('a multipart attempt that fails is aborted, and the next is a fresh upload', async () => {
    const src = join(await scratch(), 'big.bin')
    const data = new Uint8Array(MULTIPART_THRESHOLD + 1)
    for (let i = 0; i < data.length; i += 4096) data[i] = (i / 4096) % 256
    await writeFile(src, data)
    const { store, sent, uploads } = fakeS3({ drop: { kind: UploadPartCommand, times: 1 } })
    await store.putFile('big.bin', src, 'video/mp4')
    expect(sentOf(sent, CreateMultipartUploadCommand)).toHaveLength(2)
    expect(sentOf(sent, AbortMultipartUploadCommand)).toHaveLength(1)
    expect(uploads.size).toBe(0)
    expect(sha((await store.read('big.bin'))!)).toBe(sha(data))
  })
})

describe('the store from the environment', () => {
  const ALL = {
    S3_ENDPOINT: 'http://garage:3900',
    S3_REGION: 'garage',
    S3_BUCKET: 'app',
    S3_ACCESS_KEY_ID: 'GKexample',
    S3_SECRET_ACCESS_KEY: 'not-a-real-secret-value',
  }

  test('all five make a config, and a store', () => {
    expect(s3ConfigFromEnv(ALL)).toEqual({
      endpoint: 'http://garage:3900',
      region: 'garage',
      bucket: 'app',
      accessKeyId: 'GKexample',
      secretAccessKey: 'not-a-real-secret-value',
    })
    const store = objectStoreFromEnv(ALL)
    expect(store).not.toBeNull()
    expect(typeof store!.put).toBe('function')
  })

  test('none is no bucket at all, and an empty value is none', () => {
    expect(s3ConfigFromEnv({})).toBeNull()
    expect(objectStoreFromEnv({ PATH: '/usr/bin' })).toBeNull()
    expect(s3ConfigFromEnv({ S3_BUCKET: '', S3_ENDPOINT: '' })).toBeNull()
  })

  test('a partial set throws, naming what is missing and no value', () => {
    const partial = { S3_BUCKET: 'app', S3_SECRET_ACCESS_KEY: ALL.S3_SECRET_ACCESS_KEY }
    expect(() => s3ConfigFromEnv(partial)).toThrow(/S3_ENDPOINT, S3_REGION, S3_ACCESS_KEY_ID/)
    let message = ''
    try {
      objectStoreFromEnv(partial)
    } catch (err) {
      message = (err as Error).message
    }
    expect(message).toMatch(/half-configured/)
    expect(message).not.toContain(ALL.S3_SECRET_ACCESS_KEY)
  })
})

describe('objectResponse', () => {
  const obj = (contentRange: string | null): StoredObject => ({
    body: bytes(1, 2),
    contentType: 'audio/mpeg',
    contentLength: 2,
    etag: '"e"',
    contentRange,
  })

  test('answers the object with its own headers and the route’s', async () => {
    const res = objectResponse(obj(null), {
      'Cache-Control': 'private, max-age=31536000, immutable',
    })
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('audio/mpeg')
    expect(res.headers.get('Content-Length')).toBe('2')
    expect(res.headers.get('ETag')).toBe('"e"')
    expect(res.headers.get('Cache-Control')).toBe('private, max-age=31536000, immutable')
    expect([...new Uint8Array(await res.arrayBuffer())]).toEqual([1, 2])
  })

  test('a range is a 206 that says which bytes', () => {
    const res = objectResponse(obj('bytes 0-1/10'), { 'Cache-Control': 'private, no-store' })
    expect(res.status).toBe(206)
    expect(res.headers.get('Content-Range')).toBe('bytes 0-1/10')
  })
})
