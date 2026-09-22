import { createHash, createPublicKey, verify } from 'node:crypto'
import { bool, decode, int, nullable, obj, optional, str } from '../lib/contract/decode'

// The hello: how a machine running the agent introduces itself to the box.
//
// The agent generates an ed25519 keypair at install and signs every hello
// with it. The signature is over the PAYLOAD STRING exactly as the agent
// serialised it — the box never re-serialises JSON to check a signature,
// which is the mistake that makes signed JSON fragile. The envelope is
//
//   { "payload": "<json text>", "pubkey": "<32 bytes hex>", "sig": "<64 bytes hex>" }
//
// and the payload, once the signature holds, decodes to `HelloPayload`. The
// timestamp inside it bounds a replay: a hello older than five minutes (or
// from the future by as much) is refused even with a valid signature.
//
// Pure: node's crypto and nothing else, so it is tested without a database
// and reused by the route and by anything that later wants to verify what a
// node signed.

/** How far a hello's clock may be from ours, in seconds, and still count. */
export const HELLO_MAX_SKEW_SECS = 300

export type HelloPayload = {
  hostname: string
  os: string
  arch: string
  agentVersion: string
  mac: string | null
  lanIp: string | null
  statusPort: number
  osUptimeSecs: number | null
  awakeHold: boolean
  /** Seconds since the Unix epoch on the agent's clock. */
  ts: number
}

const envelopeShape = obj({ payload: str, pubkey: str, sig: str })

const payloadShape = obj({
  hostname: str,
  os: str,
  arch: optional(str, ''),
  agent_version: str,
  mac: optional(nullable(str), null),
  lan_ip: optional(nullable(str), null),
  status_port: optional(int, 7787),
  os_uptime_secs: optional(nullable(int), null),
  awake_hold: optional(bool, false),
  ts: int,
})

export type HelloVerdict =
  | {
      ok: true
      nodeId: string
      publicKey: string
      payload: HelloPayload
      raw: Record<string, unknown>
    }
  | { ok: false; reason: string }

const HEX32 = /^[0-9a-f]{64}$/
const HEX64 = /^[0-9a-f]{128}$/

/** SubjectPublicKeyInfo DER for an ed25519 key: a fixed 12-byte prefix, then the raw key. */
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex')

/** The node id every hello with this key maps to: sixteen hex chars of SHA-256(pubkey). */
export function nodeIdOf(publicKeyHex: string): string {
  return createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest('hex').slice(0, 16)
}

function signatureHolds(payload: string, pubkeyHex: string, sigHex: string): boolean {
  try {
    const key = createPublicKey({
      key: Buffer.concat([SPKI_PREFIX, Buffer.from(pubkeyHex, 'hex')]),
      format: 'der',
      type: 'spki',
    })
    return verify(null, Buffer.from(payload, 'utf8'), key, Buffer.from(sigHex, 'hex'))
  } catch {
    return false
  }
}

/**
 * Check an envelope: shape, key and signature lengths, the signature itself,
 * then the payload's shape and its clock. `now` is injectable for the tests.
 */
export function verifyHello(body: unknown, now: number = Date.now() / 1000): HelloVerdict {
  let env: { payload: string; pubkey: string; sig: string }
  try {
    env = decode(envelopeShape, body)
  } catch {
    return { ok: false, reason: 'the body is not a hello envelope' }
  }
  const pubkey = env.pubkey.toLowerCase()
  const sig = env.sig.toLowerCase()
  if (!HEX32.test(pubkey)) return { ok: false, reason: 'pubkey is not 32 bytes of hex' }
  if (!HEX64.test(sig)) return { ok: false, reason: 'sig is not 64 bytes of hex' }
  if (!signatureHolds(env.payload, pubkey, sig)) {
    return { ok: false, reason: 'the signature does not match the key' }
  }

  let raw: unknown
  try {
    raw = JSON.parse(env.payload)
  } catch {
    return { ok: false, reason: 'the payload is not JSON' }
  }
  let p: ReturnType<typeof payloadShape>
  try {
    p = decode(payloadShape, raw)
  } catch (e) {
    return {
      ok: false,
      reason: `the payload is not a hello: ${e instanceof Error ? e.message : 'bad shape'}`,
    }
  }
  if (Math.abs(p.ts - now) > HELLO_MAX_SKEW_SECS) {
    return { ok: false, reason: 'the hello is too old or too far in the future' }
  }
  if (p.hostname.trim() === '') return { ok: false, reason: 'hostname is empty' }

  return {
    ok: true,
    nodeId: nodeIdOf(pubkey),
    publicKey: pubkey,
    raw: raw as Record<string, unknown>,
    payload: {
      hostname: p.hostname,
      os: p.os,
      arch: p.arch,
      agentVersion: p.agent_version,
      mac: p.mac,
      lanIp: p.lan_ip,
      statusPort: p.status_port,
      osUptimeSecs: p.os_uptime_secs,
      awakeHold: p.awake_hold,
      ts: p.ts,
    },
  }
}
