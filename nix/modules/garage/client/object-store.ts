// object-store.ts — an app's bucket, the one way every app on the box talks to it.
//
// CANONICAL COPY: daedalus's nix/modules/garage/client/object-store.ts. Every
// app with Object storage carries this file VERBATIM at src/server/object-store.ts
// (and its test beside it), so an app is read the same way as every other and a
// fix lands everywhere by copying one file. Don't edit an app's copy: change the
// canonical one and re-copy it into each app. App-specific stores (content-
// addressed blobs, a profile tarball, screenshots by id) are built ON TOP of
// `ObjectStore`, in the app's own files.
//
// On the box the apps platform gives an app one private bucket on the shared
// Garage store and injects S3_ENDPOINT, S3_REGION, S3_BUCKET, S3_ACCESS_KEY_ID
// and S3_SECRET_ACCESS_KEY (nix/modules/garage/README.md). Records stay in
// Postgres; the bucket only holds bytes. `objectStoreFromEnv` builds the S3
// driver from those five; the in-memory driver is the hermetic stand-in for
// tests and dev. Nothing here reads `process.env` itself, so a test imports it
// freely. The secret key never appears in an error or a log line; the access
// key ID can, since Garage names it in a refusal ("Forbidden: access key GK…"),
// and it is an identifier, not a secret.
//
// Retries follow the box's rule: a request that got NO answer (a connect that
// timed out, a reset, a refusal) is tried again, up to four attempts in all,
// 100, 200 and 400 ms apart. An answer is never retried, a 500 included: a busy
// store gets more load from a retry, not less. Nor is a request the store took
// and then sat on past `requestTimeout`, for the same reason. The SDK's own
// retry is off (it treats a 5xx like a lost connection). Each attempt builds
// its request afresh, so a file is opened again rather than a consumed stream
// re-sent, and a streamed body is never retried once it has started.
//
// What Garage does differently from AWS, and the rule each one makes here:
//   - It stores no Content-Type unless told: every write sends one.
//   - Conditional PUT (If-None-Match / If-Match) is ignored: the object is
//     overwritten. Create-if-absent and optimistic locking belong in Postgres.
//   - No versioning: a delete is final, and deleting a key that is not there is
//     a success.
//   - One range per GET; any other Range gets the whole object, so only a
//     single `bytes=` range is passed on.
//   - The bucket is private and its endpoint unreachable from a browser:
//     objects leave through the app's own guarded routes (`objectResponse`),
//     never as a presigned URL.
//   - Uploads left unfinished (a multipart upload whose process died) are
//     aborted after a day by the bucket's lifecycle rule, which the platform
//     sets; an app sets no bucket rules of its own.

import { createHash, randomUUID } from 'node:crypto'
import { createReadStream, createWriteStream, type ReadStream } from 'node:fs'
import { mkdir, readFile, rename, rm, stat } from 'node:fs/promises'
import http from 'node:http'
import https from 'node:https'
import { dirname } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import {
  CopyObjectCommand,
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3'
import { Upload } from '@aws-sdk/lib-storage'
import { NodeHttpHandler } from '@smithy/node-http-handler'

export type Bytes = Uint8Array<ArrayBuffer>

/** An object the way an HTTP answer wants it: the body, and what describes it. */
export interface StoredObject {
  body: ReadableStream<Uint8Array> | Bytes
  contentType: string
  contentLength: number | null
  etag: string | null
  /** Set when one range was asked for and `body` is that range: the answer is a 206. */
  contentRange: string | null
}

/** What a listing or a HEAD knows about an object. */
export interface ObjectInfo {
  key: string
  size: number
  etag: string | null
  lastModified: Date | null
}

export interface PutOptions {
  /** Stored with the object and served back on every read of it. */
  cacheControl?: string
}

export interface ObjectStore {
  put(
    key: string,
    bytes: Bytes,
    contentType: string,
    opts?: PutOptions,
  ): Promise<{ etag: string | null }>
  /** A local file, streamed (multipart past `MULTIPART_THRESHOLD`): for bodies too big to hold. */
  putFile(
    key: string,
    path: string,
    contentType: string,
    opts?: PutOptions,
  ): Promise<{ etag: string | null }>
  /** The whole object, or null when there is none. */
  read(key: string): Promise<Bytes | null>
  /** The whole object written to `path` (atomically: a temp file, then a rename); false when there is none. */
  readToFile(key: string, path: string): Promise<boolean>
  /** The object as a stream (just `range` of it, when one is asked for), or null when there is none. */
  open(key: string, range?: string | null): Promise<StoredObject | null>
  /** Size, ETag and last-modified time, or null when there is none. */
  head(key: string): Promise<ObjectInfo | null>
  /** Every object under `prefix`, in key order, a page at a time behind the iterator. */
  list(prefix: string): AsyncIterable<ObjectInfo>
  /**
   * Copy an object; its type and cache policy come along. Copying a key onto
   * itself refreshes its last-modified time and nothing else — the way to mark
   * an object as still wanted (an age-guarded sweep reads `lastModified`).
   * Cheap on Garage: a copy reuses the blocks. Throws when `from` is missing.
   */
  copy(from: string, to: string): Promise<void>
  /** Delete every key. One that is not there counts as deleted. */
  remove(keys: readonly string[]): Promise<void>
}

/** Past this, `putFile` uploads in parts. A multiple of Garage's 1 MiB block. */
export const MULTIPART_THRESHOLD = 16 * 1024 * 1024
const PART_SIZE = 16 * 1024 * 1024

/** A Range the store cannot answer: past the end of the object. The route answers 416. */
export class RangeNotSatisfiable extends Error {
  constructor() {
    super('Range Not Satisfiable')
    this.name = 'RangeNotSatisfiable'
  }
}

/** Exactly one byte range, the only kind Garage honours. */
const SINGLE_RANGE = /^bytes=(\d*)-(\d*)$/

const singleRange = (range: string | null | undefined): string | undefined => {
  const r = range?.trim()
  const m = r?.match(SINGLE_RANGE)
  return m && (m[1] || m[2]) ? r : undefined
}

// ── S3 ──────────────────────────────────────────────────────────────────────

export interface S3Config {
  endpoint: string
  region: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * The five variables the platform injects, or null when the app has no bucket
 * (dev, tests). All five or none: a partial set is a misconfigured container,
 * and the error names the missing variables, never a value.
 */
export function s3ConfigFromEnv(env: Record<string, string | undefined>): S3Config | null {
  const names = [
    'S3_ENDPOINT',
    'S3_REGION',
    'S3_BUCKET',
    'S3_ACCESS_KEY_ID',
    'S3_SECRET_ACCESS_KEY',
  ] as const
  const missing = names.filter((n) => !env[n])
  if (missing.length === names.length) return null
  if (missing.length > 0)
    throw new Error(`object storage is half-configured: ${missing.join(', ')} unset`)
  return {
    endpoint: env.S3_ENDPOINT!,
    region: env.S3_REGION!,
    bucket: env.S3_BUCKET!,
    accessKeyId: env.S3_ACCESS_KEY_ID!,
    secretAccessKey: env.S3_SECRET_ACCESS_KEY!,
  }
}

/**
 * The client, configured for Garage. Path-style because the box publishes no
 * per-bucket hostnames; checksums only where an operation requires one (the
 * SDK's newer defaults add them to every request, and break presigned PUTs).
 * Connections are kept alive. A connect that has not completed in a second is
 * abandoned, and `withRetry` tries it again (four attempts in all): on the
 * host.containers.internal path a VPN-netns app dials, a new connection stalls
 * on its SYN for ~10 s a fifth to a half of the time, and a fresh attempt is
 * the cure. `maxAttempts: 1` turns the SDK's own retry off, because it would
 * also retry a 5xx. `requestTimeout` bounds the wait for an answer's headers,
 * never a body streaming out to a slow reader.
 */
export function s3Client(config: Omit<S3Config, 'bucket'>): S3Client {
  return new S3Client({
    endpoint: config.endpoint,
    region: config.region,
    forcePathStyle: true,
    credentials: { accessKeyId: config.accessKeyId, secretAccessKey: config.secretAccessKey },
    requestChecksumCalculation: 'WHEN_REQUIRED',
    responseChecksumValidation: 'WHEN_REQUIRED',
    maxAttempts: 1,
    requestHandler: new NodeHttpHandler({
      httpAgent: new http.Agent({ keepAlive: true, maxSockets: 32 }),
      httpsAgent: new https.Agent({ keepAlive: true, maxSockets: 32 }),
      connectionTimeout: 1_000,
      requestTimeout: 15_000,
      throwOnRequestTimeout: true,
    }),
  })
}

/** The app's bucket from its env, or null when it has none. */
export function objectStoreFromEnv(env: Record<string, string | undefined>): ObjectStore | null {
  const config = s3ConfigFromEnv(env)
  return config === null ? null : s3ObjectStore(s3Client(config), config.bucket)
}

const errorName = (err: unknown) => (err as { name?: string } | null)?.name
const errorStatus = (err: unknown) =>
  (err as { $metadata?: { httpStatusCode?: number } } | null)?.$metadata?.httpStatusCode
// NoSuchKey is a GET's answer, NotFound a HEAD's (a HEAD has no body to name
// the error). Not every 404: a GET on a bucket that is gone answers
// NoSuchBucket, and reading that as "no object" would hide a broken deployment.
const isMissing = (err: unknown) => errorName(err) === 'NoSuchKey' || errorName(err) === 'NotFound'

/** The pause before the second, third and fourth attempt. */
const RETRY_DELAYS_MS = [100, 200, 400] as const

/**
 * Did the store answer, or take the request and sit on it? An answer carries an
 * HTTP status; our `requestTimeout` firing is the store being too busy to
 * answer. Neither is retried. Everything else was thrown before an answer.
 */
const answered = (err: unknown) => {
  if (errorStatus(err) !== undefined) return true
  const e = err as { code?: string; message?: string } | null
  return e?.code === 'ETIMEDOUT' && (e.message ?? '').includes('requestTimeout')
}

/** Run `attempt` until it succeeds, it is answered, or four attempts are spent. */
async function withRetry<T>(attempt: () => Promise<T>): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await attempt()
    } catch (err) {
      const delay = RETRY_DELAYS_MS[i]
      if (answered(err) || delay === undefined) throw err
      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }
}

/**
 * `run` with a fresh read stream of `path`, closed whatever happens. (Not
 * named `use`: React's lint rules read any `use(…)` call as the hook.)
 */
async function fromFile<T>(path: string, run: (body: ReadStream) => Promise<T>): Promise<T> {
  const body = createReadStream(path)
  try {
    return await run(body)
  } finally {
    body.destroy()
  }
}

/** S3 wants the source of a copy as `<bucket>/<key>`, URI-encoded per segment. */
const copySource = (bucket: string, key: string) =>
  `${bucket}/${key.split('/').map(encodeURIComponent).join('/')}`

/**
 * Write a stream to `path` atomically: a temp file beside it, then a rename.
 * The temp name is unique per call, so two downloads to one path at once each
 * write their own file and the last rename wins whole.
 */
async function streamToFile(body: Readable, path: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true })
  const tmp = `${path}.${randomUUID()}.part`
  try {
    await pipeline(body, createWriteStream(tmp))
    await rename(tmp, path)
  } catch (err) {
    await rm(tmp, { force: true })
    throw err
  }
}

export function s3ObjectStore(client: S3Client, bucket: string): ObjectStore {
  // Every request below goes through `withRetry`, with its command built
  // inside the attempt, so each try sends a fresh one.
  async function get(key: string, range?: string) {
    try {
      return await withRetry(() =>
        client.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: range })),
      )
    } catch (err) {
      if (isMissing(err)) return null
      if (errorStatus(err) === 416) throw new RangeNotSatisfiable()
      throw err
    }
  }

  async function head(key: string) {
    try {
      return await withRetry(() => client.send(new HeadObjectCommand({ Bucket: bucket, Key: key })))
    } catch (err) {
      if (isMissing(err)) return null
      throw err
    }
  }

  return {
    async put(key, bytes, contentType, opts) {
      const out = await withRetry(() =>
        client.send(
          new PutObjectCommand({
            Bucket: bucket,
            Key: key,
            Body: bytes,
            ContentType: contentType,
            ContentLength: bytes.byteLength,
            CacheControl: opts?.cacheControl,
          }),
        ),
      )
      return { etag: out.ETag ?? null }
    },

    async putFile(key, path, contentType, opts) {
      const { size } = await stat(path)
      const params = {
        Bucket: bucket,
        Key: key,
        ContentType: contentType,
        CacheControl: opts?.cacheControl,
      }
      // Each attempt opens the file again: a stream a failed attempt consumed
      // cannot be rewound, and re-sending it would store a truncated object.
      if (size <= MULTIPART_THRESHOLD) {
        const out = await withRetry(() =>
          fromFile(path, (Body) =>
            client.send(new PutObjectCommand({ ...params, Body, ContentLength: size })),
          ),
        )
        return { etag: out.ETag ?? null }
      }
      const out = await withRetry(() =>
        fromFile(path, (Body) =>
          new Upload({
            client,
            params: { ...params, Body },
            partSize: PART_SIZE,
            queueSize: 4,
            // A failed attempt aborts its parts before the next one starts
            // afresh; the bucket's lifecycle rule catches the ones a dead
            // process could not.
            leavePartsOnError: false,
          }).done(),
        ),
      )
      return { etag: out.ETag ?? null }
    },

    async read(key) {
      const out = await get(key)
      return out ? new Uint8Array(await out.Body!.transformToByteArray()) : null
    },

    async readToFile(key, path) {
      const out = await get(key)
      if (!out) return false
      await streamToFile(out.Body as Readable, path)
      return true
    },

    async open(key, range) {
      const out = await get(key, singleRange(range))
      if (!out) return null
      return {
        body: out.Body!.transformToWebStream() as ReadableStream<Uint8Array>,
        contentType: out.ContentType ?? 'application/octet-stream',
        contentLength: out.ContentLength ?? null,
        etag: out.ETag ?? null,
        contentRange: out.ContentRange ?? null,
      }
    },

    async head(key) {
      const out = await head(key)
      if (!out) return null
      return {
        key,
        size: out.ContentLength ?? 0,
        etag: out.ETag ?? null,
        lastModified: out.LastModified ?? null,
      }
    },

    async *list(prefix) {
      let token: string | undefined
      do {
        const page = token
        const out = await withRetry(() =>
          client.send(
            new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: page }),
          ),
        )
        for (const o of out.Contents ?? []) {
          if (o.Key === undefined) continue
          yield {
            key: o.Key,
            size: o.Size ?? 0,
            etag: o.ETag ?? null,
            lastModified: o.LastModified ?? null,
          }
        }
        token = out.IsTruncated ? out.NextContinuationToken : undefined
      } while (token)
    },

    async copy(from, to) {
      // Onto itself, S3 accepts a copy only when something changes: REPLACE
      // the metadata with what the object already carries, so nothing does
      // but the time.
      if (from === to) {
        const meta = await head(from)
        if (!meta) throw new Error(`copy: ${from} does not exist`)
        await withRetry(() =>
          client.send(
            new CopyObjectCommand({
              Bucket: bucket,
              Key: to,
              CopySource: copySource(bucket, from),
              MetadataDirective: 'REPLACE',
              ContentType: meta.ContentType,
              CacheControl: meta.CacheControl,
              Metadata: meta.Metadata,
            }),
          ),
        )
        return
      }
      await withRetry(() =>
        client.send(
          new CopyObjectCommand({ Bucket: bucket, Key: to, CopySource: copySource(bucket, from) }),
        ),
      )
    },

    async remove(keys) {
      // DeleteObjects takes at most 1000 keys. Quiet: the answer lists only
      // what failed, and anything listed is a failure the caller must see —
      // a caller usually clears the row that names the object right after.
      for (let i = 0; i < keys.length; i += 1000) {
        const batch = keys.slice(i, i + 1000)
        const out = await withRetry(() =>
          client.send(
            new DeleteObjectsCommand({
              Bucket: bucket,
              Delete: { Objects: batch.map((Key) => ({ Key })), Quiet: true },
            }),
          ),
        )
        const failed = out.Errors ?? []
        if (failed.length > 0) {
          throw new Error(
            `${failed.length} of ${batch.length} objects were not deleted (first: ${failed[0]!.Key}, ${failed[0]!.Code})`,
          )
        }
      }
    },
  }
}

// ── Memory (tests, dev) ─────────────────────────────────────────────────────

type MemoryObject = {
  bytes: Bytes
  contentType: string
  cacheControl: string | undefined
  etag: string
  lastModified: Date
}

/** The same contract held in a Map: the hermetic stand-in for the bucket. */
export function memoryObjectStore(): ObjectStore {
  const objects = new Map<string, MemoryObject>()
  const md5 = (b: Uint8Array) => `"${createHash('md5').update(b).digest('hex')}"`

  const store: ObjectStore = {
    async put(key, bytes, contentType, opts) {
      const etag = md5(bytes)
      objects.set(key, {
        bytes: bytes.slice(),
        contentType,
        cacheControl: opts?.cacheControl,
        etag,
        lastModified: new Date(),
      })
      return { etag }
    },

    async putFile(key, path, contentType, opts) {
      return store.put(key, new Uint8Array(await readFile(path)), contentType, opts)
    },

    async read(key) {
      return objects.get(key)?.bytes.slice() ?? null
    },

    async readToFile(key, path) {
      const obj = objects.get(key)
      if (!obj) return false
      await streamToFile(Readable.from([obj.bytes.slice()]), path)
      return true
    },

    async open(key, range) {
      const obj = objects.get(key)
      if (!obj) return null
      const size = obj.bytes.length
      const r = byteRange(singleRange(range), size)
      const body = r ? obj.bytes.slice(r.start, r.end + 1) : obj.bytes.slice()
      return {
        body,
        contentType: obj.contentType,
        contentLength: body.length,
        etag: obj.etag,
        contentRange: r ? `bytes ${r.start}-${r.end}/${size}` : null,
      }
    },

    async head(key) {
      const obj = objects.get(key)
      return obj
        ? { key, size: obj.bytes.length, etag: obj.etag, lastModified: obj.lastModified }
        : null
    },

    async *list(prefix) {
      const keys = [...objects.keys()].filter((k) => k.startsWith(prefix)).sort()
      for (const key of keys) {
        const obj = objects.get(key)
        if (obj)
          yield { key, size: obj.bytes.length, etag: obj.etag, lastModified: obj.lastModified }
      }
    },

    async copy(from, to) {
      const obj = objects.get(from)
      if (!obj) throw new Error(`copy: ${from} does not exist`)
      objects.set(to, { ...obj, bytes: obj.bytes.slice(), lastModified: new Date() })
    },

    async remove(keys) {
      for (const key of keys) objects.delete(key)
    },
  }
  return store
}

/** Where one `bytes=` range falls in `size` bytes, as S3 reads it; null means the whole object. */
function byteRange(range: string | undefined, size: number): { start: number; end: number } | null {
  const m = range?.match(SINGLE_RANGE)
  if (!m) return null
  const [first, last] = [m[1] ? Number(m[1]) : null, m[2] ? Number(m[2]) : null]
  if (first !== null && last !== null && last < first) return null // not a valid range, so ignored
  if (first === null) {
    // A suffix: the last N bytes, all of them when N is past the start.
    if (last === 0) throw new RangeNotSatisfiable()
    return { start: Math.max(0, size - last!), end: size - 1 }
  }
  if (first >= size) throw new RangeNotSatisfiable()
  return { start: first, end: last === null ? size - 1 : Math.min(last, size - 1) }
}

// ── Serving ─────────────────────────────────────────────────────────────────

/**
 * A stored object as the answer to a browser: a 206 when it is one range, the
 * object's own type, length and ETag, plus the route's `headers` (its cache
 * policy and anything of its own). The body streams; nothing is buffered here.
 */
export function objectResponse(obj: StoredObject, headers: Record<string, string>): Response {
  const out = new Headers(headers)
  out.set('Content-Type', obj.contentType)
  if (obj.contentLength !== null) out.set('Content-Length', String(obj.contentLength))
  if (obj.etag) out.set('ETag', obj.etag)
  if (obj.contentRange) out.set('Content-Range', obj.contentRange)
  return new Response(obj.body, { status: obj.contentRange ? 206 : 200, headers: out })
}

/** A Readable from bytes, for callers that pipe (archives, hashing). */
export const bytesToReadable = (bytes: Bytes): Readable => Readable.from([bytes])
