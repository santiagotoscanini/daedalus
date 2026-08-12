import { DecodeError, type Decoder, decode } from './decode'

// JSON blobs bound into the environment by daedalus.nix (IMAGE_TAGS,
// VPN_EGRESS, DHCP_CONFIG, …). Transitional: the env-vs-export rule says
// structured facts belong in /export domains, and each of these moves there
// during the wave-2 migration — this helper exists so their read sites decode
// instead of cast in the meantime, and shrinks as the blobs migrate.

const complained = new Set<string>()

export function readEnvJson<T>(name: string, decoder: Decoder<T>, fallback: T): T {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  try {
    return decode(decoder, JSON.parse(raw))
  } catch (e) {
    // Once per variable per process: env cannot change until a restart, so
    // repeating the complaint per render would only bury other logs.
    if (!complained.has(name)) {
      complained.add(name)
      console.error(`[env] ${name}: ${e instanceof DecodeError ? e.message : 'unparseable JSON'}`)
    }
    return fallback
  }
}
