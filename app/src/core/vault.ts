import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { env } from '../host/env'
import { appSecretFile } from '../lib/apps/secret-keys'
import { errorText } from '../lib/redact'
import type { Result } from '../lib/result'
import {
  ciphertextError,
  jsonCiphertextError,
  jsonVaultValuesError,
  VAULT_JSON_KEYS,
  type VaultFile,
  type VaultJsonFile,
  type VaultJsonValues,
  type VaultPath,
} from '../lib/vault'

// Encrypting a secret for site/vault/, in this container.
//
// The static sops mounted at /usr/local/bin/sops and the public recipients in
// /site/.sops.yaml are all it takes: the container holds no age identity, so
// it can write a secret and never read one back, and the bridge directory (on
// a snapshotted dataset) only ever sees ciphertext. Every secret the UI sets
// goes through here: the Cloudflare token (core/settings/cloudflare-token.ts)
// and the GitHub App's key (core/settings/github-app.ts) then go to Apply as
// their own change (host/apply-flow.ts runSecretApply); an app's secret
// (lib/apps/secrets.ts) goes to its own bridge verb instead (sealAppSecret).

/** The sops file's bytes, or why nothing was sealed. */
export type Sealed = Result<string>

/** Longest first, so a value never survives as the tail of a shorter match. */
function redact(text: string, secrets: string[]): string {
  const needles = [...new Set(secrets.filter((s) => s !== ''))].sort((a, b) => b.length - a.length)
  return needles.reduce((acc, s) => acc.replaceAll(s, '[secret]'), text)
}

/** How long sops may run before it is killed. It encrypts a few kilobytes. */
export const SOPS_TIMEOUT_MS = 30_000

/**
 * Encrypt with the mounted static sops. Resolves with the file sops wrote.
 *
 * Two details that each cost a failed run. The value goes in on stdin with NO
 * file argument: node's pipes are sockets, which `/dev/stdin` cannot open
 * (ENXIO), while sops reading its own stdin can. And sops runs FROM the site
 * directory, because the creation rule's `^vault/…` is matched against the
 * `--filename-override` path relative to where sops stands.
 */
function encrypt(
  file: VaultPath,
  type: 'binary' | 'json',
  input: string,
  secrets: string[],
): Promise<string> {
  const site = env.get('SITE_PATH')
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/local/bin/sops',
      [
        '--config',
        join(site, '.sops.yaml'),
        'encrypt',
        '--input-type',
        type,
        '--output-type',
        type,
        '--filename-override',
        file,
      ],
      // A bare environment: nothing of the app's own secrets is handed to it.
      {
        cwd: site,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { PATH: '/usr/bin:/bin', HOME: '/tmp' },
      },
    )
    let out = ''
    let err = ''
    // Exactly one of error, close and the kill timer settles the promise.
    let settled = false
    let timer: ReturnType<typeof setTimeout> | undefined
    const settle = (finish: () => void) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      finish()
    }
    // A sops that hangs would hold its caller forever, and the GitHub App
    // callback calls this under a lock. SIGKILL: a hung process is not asked.
    timer = setTimeout(() => {
      settle(() => {
        child.kill('SIGKILL')
        reject(new Error('sops timed out'))
      })
    }, SOPS_TIMEOUT_MS)
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      out += c
    })
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      err += c
    })
    child.on('error', (e) => {
      settle(() => {
        // The spawn error keeps its errno and syscall on `cause`; the message
        // is the only part that is ever printed.
        reject(new Error(`sops could not run (${e.message})`, { cause: e }))
      })
    })
    child.on('close', (code) => {
      settle(() => {
        if (code === 0) {
          resolve(out)
          return
        }
        const said = redact(err, secrets).trim().split('\n')[0] ?? ''
        reject(new Error(`sops failed${said === '' ? '' : `: ${said}`}`))
      })
    })
    // A sops that dies before reading its input makes this pipe EPIPE; the
    // exit is what reports it, and an unhandled stream error would crash.
    child.stdin.on('error', () => undefined)
    child.stdin.end(input)
  })
}

/**
 * The value, encrypted for `file` and checked to be a real sops file that does
 * not carry it. The value is never logged, and no reason below repeats it.
 */
export async function sealForVault(file: VaultFile, value: string): Promise<Sealed> {
  let out: string
  try {
    out = await encrypt(file, 'binary', value, [value])
  } catch (e) {
    return { ok: false, reason: errorText(e) }
  }
  const bad = ciphertextError(out, value)
  return bad === null
    ? { ok: true, value: out }
    : { ok: false, reason: `Nothing was sent: ${bad}.` }
}

/**
 * Several values, encrypted as one sops JSON file for `file` — one encrypted
 * string per key, in the order VAULT_JSON_KEYS declares — and checked like
 * sealForVault.
 *
 * Before anything else, every declared key must hold a non-empty string with
 * no surrounding whitespace (jsonVaultValuesError); a key the file does not
 * declare is neither sealed nor looked at. Every declared value, each of its
 * lines and its JSON-escaped form are redacted from what sops says on failure:
 * a PEM line alone is still the key. Never throws — every failure is a reason.
 */
export async function sealJsonForVault<F extends VaultJsonFile>(
  file: F,
  values: VaultJsonValues<F>,
): Promise<Sealed> {
  try {
    const invalid = jsonVaultValuesError(file, values)
    if (invalid !== null) return { ok: false, reason: `Nothing was sent: ${invalid}.` }
    const plain: Record<string, string> = values
    const keys: readonly string[] = VAULT_JSON_KEYS[file]
    const declared = keys.map((k): [string, string] => [k, plain[k] ?? ''])
    const secrets = declared.flatMap(([, v]) => [
      v,
      JSON.stringify(v).slice(1, -1),
      ...v.split(/\r?\n/).map((l) => l.trim()),
    ])
    let out: string
    try {
      out = await encrypt(file, 'json', JSON.stringify(Object.fromEntries(declared)), secrets)
    } catch (e) {
      return { ok: false, reason: errorText(e) }
    }
    const bad = jsonCiphertextError(file, out, values)
    return bad === null
      ? { ok: true, value: out }
      : { ok: false, reason: `Nothing was sent: ${bad}.` }
  } catch {
    return { ok: false, reason: 'Nothing was sent: the values could not be sealed.' }
  }
}

/**
 * ONE app secret, sealed for `site/vault/apps/<app>-env.sops`.
 *
 * The whole of what this container can do to an app's secrets. It produces a
 * sops document holding a single value, sealed to the recipients that file's
 * creation rule names — the same two the host decrypts with — and hands it to
 * the bridge; the host opens it in memory and merges the key
 * (nix/stacks/daedalus/host/secret-set.sh). Reading the file back, re-emitting it,
 * or replacing it whole are all impossible here, because the identity that
 * could is deliberately absent.
 *
 * `--filename-override` is what makes the creation rule match, so the path is
 * built by `appSecretFile` and never spelled out at a call site. The output is
 * checked exactly like `sealForVault`'s: sops exits 0 on more than success, so
 * "is this a real sops file, and does it fail to contain the value" is the
 * last thing that happens before anything leaves this process.
 */
export async function sealAppSecret(app: string, value: string): Promise<Sealed> {
  // An empty secret is refused rather than sealed: it would read back as "the
  // variable is set" while the app sees nothing, which is the failure mode
  // operator-secrets-lib.nix's header calls the worst kind — green units, no
  // value. Removing the key is the way to say "not set".
  if (value === '') return { ok: false, reason: 'Nothing was sent: the value is empty.' }
  let out: string
  try {
    out = await encrypt(appSecretFile(app), 'binary', value, [value])
  } catch (e) {
    return { ok: false, reason: errorText(e) }
  }
  const bad = ciphertextError(out, value)
  return bad === null
    ? { ok: true, value: out }
    : { ok: false, reason: `Nothing was sent: ${bad}.` }
}
