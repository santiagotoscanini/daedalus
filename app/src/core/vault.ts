import { spawn } from 'node:child_process'
import { join } from 'node:path'
import { ciphertextError, type VaultFile } from '../lib/vault'

// Encrypting a secret for site/vault/, in this container.
//
// The static sops mounted at /usr/local/bin/sops and the public recipients in
// /site/.sops.yaml are all it takes: the container holds no age identity, so
// it can write a secret and never read one back, and the bridge directory (on
// a snapshotted dataset) only ever sees ciphertext. Every secret the UI sets
// goes through here — the Cloudflare token (core/settings/cloudflare-token.ts)
// and the GitHub sign-in (core/settings/github-signin.ts) — and then to Apply
// as its own change (lib/apply-flow.ts runSecretApply).

export type Sealed = { ok: true; ciphertext: string } | { ok: false; reason: string }

/**
 * Encrypt with the mounted static sops. Resolves with the file sops wrote.
 *
 * Two details that each cost a failed run. The value goes in on stdin with NO
 * file argument: node's pipes are sockets, which `/dev/stdin` cannot open
 * (ENXIO), while sops reading its own stdin can. And sops runs FROM the site
 * directory, because the creation rule's `^vault/…` is matched against the
 * `--filename-override` path relative to where sops stands.
 */
function encrypt(file: VaultFile, value: string): Promise<string> {
  const site = process.env.SITE_PATH ?? '/site'
  return new Promise((resolve, reject) => {
    const child = spawn(
      '/usr/local/bin/sops',
      [
        '--config',
        join(site, '.sops.yaml'),
        'encrypt',
        '--input-type',
        'binary',
        '--output-type',
        'binary',
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
    child.stdout.setEncoding('utf8').on('data', (c: string) => {
      out += c
    })
    child.stderr.setEncoding('utf8').on('data', (c: string) => {
      err += c
    })
    child.on('error', (e) => {
      reject(new Error(`sops could not run (${e.message})`))
    })
    child.on('close', (code) => {
      if (code === 0) {
        resolve(out)
        return
      }
      const said = err.replaceAll(value, '[secret]').trim().split('\n')[0] ?? ''
      reject(new Error(`sops failed${said === '' ? '' : `: ${said}`}`))
    })
    child.stdin.end(value)
  })
}

/**
 * The value, encrypted for `file` and checked to be a real sops file that does
 * not carry it. The value is never logged, and no reason below repeats it.
 */
export async function sealForVault(file: VaultFile, value: string): Promise<Sealed> {
  let out: string
  try {
    out = await encrypt(file, value)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'sops failed' }
  }
  const bad = ciphertextError(out, value)
  return bad === null
    ? { ok: true, ciphertext: out }
    : { ok: false, reason: `Nothing was sent: ${bad}.` }
}
