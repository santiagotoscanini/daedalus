import { spawn } from 'node:child_process'
import { join } from 'node:path'
import {
  CLOUDFLARE_TOKEN_FILE,
  CLOUDFLARE_TOKEN_SECRET,
  ciphertextError,
  tokenShapeError,
} from '../../lib/cloudflare-token'
import { getJsonResult } from '../../lib/http'
import type { Ctx } from '../ctx'

// Settings › Integrations › Cloudflare › Replace token — Phase 6, the first
// secret set from the UI.
//
// The order is the design. The candidate is checked against Cloudflare doing
// everything the box does with a token — seeing the zone, reading DNS,
// writing a TXT record and taking it away again (a certificate renewal's two
// calls), reading the tunnel — so a token that would break the box is refused
// before anything changes. Only then is it encrypted, HERE, with the static
// sops mounted into this container and the public recipients in
// /site/.sops.yaml: the container holds no age identity, so it can write the
// secret and never read it back, and the bridge directory (on a snapshotted
// dataset) only ever sees ciphertext. The ciphertext goes to Apply as its own
// change (lib/apply-flow.ts runSecretApply); nix renders it for all four
// consumers and restarts them (stacks/cloudflared, fleet.cloudflare.tokenFromSite).
//
// The token is never stored, logged or returned. Every error below is written
// without it, and sops's stderr is scrubbed of it before it is repeated.

const CF = 'https://api.cloudflare.com/client/v4'

export type TokenReplaceOutcome =
  | { ok: true; id: string; zones: string[] }
  | { ok: false; reason: string }

type Checked = { ok: true; zones: string[] } | { ok: false; reason: string }

async function check(ctx: Ctx, token: string): Promise<Checked> {
  const headers = { Authorization: `Bearer ${token}` }

  const verify = await getJsonResult<{ result?: { status?: string } }>(`${CF}/user/tokens/verify`, {
    headers,
  })
  if (!verify.ok) {
    return {
      ok: false,
      reason:
        verify.status === null
          ? 'Cloudflare did not answer; nothing was changed.'
          : 'Cloudflare does not recognise this token.',
    }
  }
  const status = verify.body.result?.status
  if (status !== 'active') {
    return { ok: false, reason: `Cloudflare says this token is ${status ?? 'not active'}.` }
  }

  const zones = await getJsonResult<{ result?: { id?: string; name?: string }[] }>(
    `${CF}/zones?per_page=50`,
    { headers },
  )
  if (!zones.ok) {
    return { ok: false, reason: 'The token cannot list zones: it needs Zone › Zone › Read.' }
  }
  const list = zones.body.result ?? []
  const names = list
    .map((z) => z.name ?? '')
    .filter((n) => n !== '')
    .sort()
  const zoneId = ctx.env('CF_ZONE_ID') ?? ''
  const zone = list.find((z) => z.id === zoneId)
  if (zoneId !== '' && zone === undefined) {
    return {
      ok: false,
      reason: 'The token cannot see this box’s zone. Include it under Zone Resources.',
    }
  }

  if (zone?.name !== undefined) {
    // Edit cannot be proven by reading, and a renewal fails months later if it
    // is missing. So write and remove a TXT record: the renewal's own calls.
    const json = { ...headers, 'Content-Type': 'application/json' }
    const created = await getJsonResult<{ result?: { id?: string } }>(
      `${CF}/zones/${zoneId}/dns_records`,
      {
        method: 'POST',
        headers: json,
        body: JSON.stringify({
          type: 'TXT',
          name: `_daedalus-token-check.${zone.name}`,
          content: '"daedalus token check, removed at once"',
          ttl: 60,
        }),
      },
    )
    const recordId = created.ok ? created.body.result?.id : undefined
    if (recordId === undefined) {
      return {
        ok: false,
        reason: 'The token cannot write DNS records: it needs Zone › DNS › Edit.',
      }
    }
    const removed = await getJsonResult(`${CF}/zones/${zoneId}/dns_records/${recordId}`, {
      method: 'DELETE',
      headers,
    })
    if (!removed.ok) {
      return {
        ok: false,
        reason: `The token wrote a check record but could not remove it. Delete _daedalus-token-check.${zone.name} by hand.`,
      }
    }
  }

  const account = ctx.env('CF_ACCOUNT_ID') ?? ''
  const tunnel = ctx.env('CF_TUNNEL_ID') ?? ''
  if (account !== '' && tunnel !== '') {
    const read = await getJsonResult(`${CF}/accounts/${account}/cfd_tunnel/${tunnel}`, {
      headers,
    })
    if (!read.ok) {
      return {
        ok: false,
        reason:
          'The token cannot read the tunnel: it needs Account › Cloudflare One Connector: cloudflared › Read.',
      }
    }
  }

  return { ok: true, zones: names }
}

/**
 * Encrypt with the mounted static sops. Resolves with the file sops wrote.
 *
 * Two details that each cost a failed run. The value goes in on stdin with NO
 * file argument: node's pipes are sockets, which `/dev/stdin` cannot open
 * (ENXIO), while sops reading its own stdin can. And sops runs FROM the site
 * directory, because the creation rule's `^vault/…` is matched against the
 * `--filename-override` path relative to where sops stands.
 */
function encrypt(token: string): Promise<string> {
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
        CLOUDFLARE_TOKEN_FILE,
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
      const said = err.replaceAll(token, '[token]').trim().split('\n')[0] ?? ''
      reject(new Error(`sops failed${said === '' ? '' : `: ${said}`}`))
    })
    child.stdin.end(token)
  })
}

export async function replaceCloudflareToken(
  ctx: Ctx,
  actor: string,
  raw: string,
): Promise<TokenReplaceOutcome> {
  const token = raw.trim()
  const shape = tokenShapeError(token)
  if (shape !== null) return { ok: false, reason: shape }

  if (ctx.env('CF_TOKEN_FROM_SITE') !== '1') {
    return {
      ok: false,
      reason:
        'The box still reads the token from stacks/cloudflared/env.sops, so a token set here would change nothing yet (fleet.cloudflare.tokenFromSite is off).',
    }
  }
  if (token === ctx.secret('CF_API_TOKEN')) {
    return { ok: false, reason: 'That is the token the box already uses.' }
  }

  const checked = await check(ctx, token)
  if (!checked.ok) return checked

  let ciphertext: string
  try {
    ciphertext = await encrypt(token)
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'sops failed' }
  }
  const bad = ciphertextError(ciphertext, token)
  if (bad !== null) return { ok: false, reason: `Nothing was sent: ${bad}.` }

  const { runSecretApply } = await import('../../lib/apply-flow')
  const outcome = await runSecretApply(actor, {
    file: CLOUDFLARE_TOKEN_FILE,
    name: CLOUDFLARE_TOKEN_SECRET,
    ciphertext,
  })
  return outcome.ok
    ? { ok: true, id: outcome.id, zones: checked.zones }
    : { ok: false, reason: outcome.reason }
}
