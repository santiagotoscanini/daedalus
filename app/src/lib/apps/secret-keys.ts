// An app's operator secrets, as names — never as values.
//
// Pure, no node builtins: the Secrets tab imports it, and the rule of this
// codebase is that a module a route imports VALUES from must be browser-safe
// (see lib/env-groups.ts). Everything that touches the disk or a subprocess
// lives in host/app-secrets.ts and core/app-secrets.ts.
//
// WHY THERE IS NO "READ" HALF ANYWHERE. daedalus holds an encrypt-only sops
// identity — the container mounts a static sops binary and the PUBLIC
// recipients in site/.sops.yaml, and no age key at all (stacks/daedalus).
// So it can seal a value it can never open again. The editor this module
// serves is therefore write-only by construction, not by policy: Add, Replace,
// Remove. There is no reveal, and "turn this secret back into a plain
// variable" does not exist — a secret can only be removed and retyped as one.
//
// What the UI CAN show is which keys exist, because a sops dotenv file keeps
// its key names in the clear:
//
//   INVITE_CODE=ENC[AES256_GCM,data:…]
//
// `appSecretKeys` reads exactly that, off the ciphertext, and is the reason
// the tab can list an app's secrets without decrypting anything.

/**
 * An environment variable name, POSIX-style: a letter or underscore, then
 * letters, digits and underscores.
 *
 * This is a SECURITY control, not tidiness. The name becomes an index in a
 * `sops --set` invocation on the host and a key in a dotenv file a container
 * sources, so anything that could carry a quote, a bracket, a newline or a
 * path separator is refused here, again at the server function, and a third
 * time by the host agent (stacks/daedalus/host/secret-set.sh). Three checks
 * because no one of them may be the only one.
 */
const KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** Comfortably past any real variable name, and short enough to be a bound. */
const SECRET_KEY_MAX = 64

/**
 * sops's own bookkeeping rows in a dotenv file — `sops_mac`, `sops_version`,
 * `sops_age__list_0__map_enc` and friends. They are not the app's variables,
 * they must never be listed as such, and a request to set one would corrupt
 * the file's metadata rather than add a secret.
 */
const SOPS_META = 'sops_'

/**
 * Why `key` is not a name this may set, or null when it is. The reason names
 * the KEY, never a value — every string this module produces is safe to show.
 */
export function secretKeyError(key: unknown): string | null {
  if (typeof key !== 'string' || key === '') return 'no variable name was given'
  if (key.length > SECRET_KEY_MAX) {
    return `a variable name may be at most ${SECRET_KEY_MAX} characters`
  }
  if (!KEY_RE.test(key)) {
    return 'a variable name is a letter or underscore followed by letters, digits and underscores'
  }
  if (key.startsWith(SOPS_META)) return `names beginning with ${SOPS_META} belong to sops itself`
  return null
}

/** `secretKeyError` as a predicate, for the places that only branch. */
export function isSecretKey(key: unknown): key is string {
  return secretKeyError(key) === null
}

/**
 * The key names a sops dotenv file holds, in file order.
 *
 * Reads the CIPHERTEXT. A sops dotenv is `NAME=ENC[…]` one per line, so the
 * names are plain and the values are not — which is exactly the asymmetry this
 * feature needs. sops's own rows are dropped, and so is any line whose name
 * would not pass `secretKeyError`: this list is rendered as the set of keys an
 * editor may Replace or Remove, and a name it could not send is not one.
 */
export function appSecretKeys(ciphertext: string): string[] {
  const keys: string[] = []
  for (const line of ciphertext.split('\n')) {
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq)
    if (!isSecretKey(key)) continue
    keys.push(key)
  }
  return keys
}

/**
 * Where an app's operator secrets live, relative to the site directory.
 *
 * Spelled out here because three places need the same string and none of them
 * may invent it: the container's `--filename-override` (so site/.sops.yaml's
 * `^vault/(apps/)?[a-z0-9-]+\.sops$` creation rule matches and the file is
 * sealed to the right recipients), the host agent's target, and the UI's
 * caption. The host still derives its own copy from nix rather than trusting
 * this one — see VAULT_APP_SECRETS in stacks/daedalus/daedalus.nix.
 */
export function appSecretFile(app: string): `vault/apps/${string}-env.sops` {
  return `vault/apps/${app}-env.sops`
}

/** When a key was last written, and by whom, from the git history of the file. */
export type SecretKeyHistory = {
  /** ISO commit date of the newest commit whose diff added this key's line. */
  setAt: string
  /** The person the commit records — the Apply trailer's actor, else the author. */
  actor: string
  /** Short rev, so a curious operator can go and look. */
  rev: string
}

/** One key of an app's secrets file, as the editor renders it. */
export type AppSecretKey = { key: string; history: SecretKeyHistory | null }
