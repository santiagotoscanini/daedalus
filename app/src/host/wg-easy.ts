import { readFile } from 'node:fs/promises'
import { env } from './env'

// wg-easy's API, as a Mac's log-in uses it (host/enroll.ts): a client made,
// confined and read back, and deleted when the machine logs out or is revoked.
// Nothing else — the rest of that API (its hooks run shell) is not ours to call.
//
// The engine's wg-easy module (nix/modules/wg-easy) gives this container the
// API on a bridge of the two (WG_EASY_URL), never through traefik, and HTTP
// Basic as wg-easy's one password account: WG_EASY_CREDENTIALS is a file of
// one line, `username:password`, read on every call so a rotation needs no
// restart. The calls are the ones agent/e2e-tunnel.sh drives against a real
// wg-easy 15.4.0. Writes are never retried: a create that timed out may have
// made a client, and the caller's rollback is what deals with it.
//
// Never log a body: a client's GET and its configuration carry its private key.

/** One call's whole budget: the API is on a local bridge. */
const TIMEOUT_MS = 8_000

/** A client as wg-easy's `GET /api/client/:id` answers it; posted back whole. */
export type WgClient = Record<string, unknown> & { id: number }

export type WgEasy = {
  /** `POST /api/client`: a new client, its keys wg-easy's. Its id. */
  createClient: (name: string) => Promise<number>
  getClient: (id: number) => Promise<WgClient>
  /** `POST /api/client/:id` with the whole client (wg-easy validates every field). */
  updateClient: (id: number, client: Record<string, unknown>) => Promise<void>
  /** `GET /api/client/:id/configuration`: wg-quick text, its private key included. */
  configuration: (id: number) => Promise<string>
  /** `DELETE /api/client/:id`; one that is gone already counts as deleted. */
  deleteClient: (id: number) => Promise<void>
  getInterface: () => Promise<Record<string, unknown>>
  updateInterface: (iface: Record<string, unknown>) => Promise<void>
}

export class WgEasyError extends Error {
  readonly status: number | null
  constructor(message: string, status: number | null = null) {
    super(message)
    this.name = 'WgEasyError'
    this.status = status
  }
}

type Fetch = (url: string, init: RequestInit) => Promise<Response>

/** A client for `base`, authenticating with what `credentials()` reads. */
export function makeWgEasy(opts: {
  base: string
  credentials: () => Promise<string>
  fetch?: Fetch
}): WgEasy {
  const doFetch: Fetch = opts.fetch ?? ((u, i) => fetch(u, i))
  const base = opts.base.replace(/\/+$/, '')

  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const userinfo = await opts.credentials()
    let res: Response
    try {
      res = await doFetch(`${base}${path}`, {
        method,
        headers: {
          authorization: `Basic ${Buffer.from(userinfo).toString('base64')}`,
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        redirect: 'manual',
      })
    } catch (e) {
      throw new WgEasyError(
        `wg-easy did not answer ${method} ${path}: ${e instanceof Error ? e.message : String(e)}`,
      )
    }
    if (!res.ok) {
      // wg-easy's error bodies are its own messages ({message, statusMessage});
      // one line of it, never a client's fields.
      let why = ''
      try {
        const j = (await res.json()) as { message?: unknown; statusMessage?: unknown }
        const m = typeof j.message === 'string' ? j.message : j.statusMessage
        why = typeof m === 'string' ? `: ${m.slice(0, 200)}` : ''
      } catch {
        why = ''
      }
      const hint =
        res.status === 401 || res.status === 403
          ? ' (the credentials were refused: is password login on, and the account without TOTP?)'
          : ''
      throw new WgEasyError(
        `wg-easy answered ${method} ${path} with ${String(res.status)}${why}${hint}`,
        res.status,
      )
    }
    return res
  }

  const json = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const res = await call(method, path, body)
    try {
      return await res.json()
    } catch {
      throw new WgEasyError(`wg-easy answered ${method} ${path} with something other than JSON`)
    }
  }
  const record = (v: unknown, what: string): Record<string, unknown> => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) {
      throw new WgEasyError(`wg-easy's ${what} is not an object`)
    }
    return v as Record<string, unknown>
  }

  return {
    createClient: async (name) => {
      const r = record(await json('POST', '/api/client', { name, expiresAt: null }), 'new client')
      const id = r.clientId
      if (typeof id !== 'number' || !Number.isSafeInteger(id) || id < 0) {
        throw new WgEasyError('wg-easy made a client but did not say its id')
      }
      return id
    },
    getClient: async (id) => {
      const r = record(await json('GET', `/api/client/${String(id)}`), 'client')
      if (r.id !== id) throw new WgEasyError(`wg-easy answered client ${String(id)} with another`)
      return r as WgClient
    },
    updateClient: async (id, client) => {
      await call('POST', `/api/client/${String(id)}`, client)
    },
    configuration: async (id) =>
      (await call('GET', `/api/client/${String(id)}/configuration`)).text(),
    deleteClient: async (id) => {
      try {
        await call('DELETE', `/api/client/${String(id)}`)
      } catch (e) {
        if (e instanceof WgEasyError && e.status === 404) return
        throw e
      }
    },
    getInterface: async () => record(await json('GET', '/api/admin/interface'), 'interface'),
    updateInterface: async (iface) => {
      await call('POST', '/api/admin/interface', iface)
    },
  }
}

/** `username:password` from the file, its line end dropped; refused when it is not that. */
export async function readCredentials(path: string): Promise<string> {
  let text: string
  try {
    text = await readFile(path, 'utf8')
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code
    throw new WgEasyError(`wg-easy's credentials could not be read (${code ?? 'error'})`)
  }
  const line = text.replace(/\r?\n$/, '')
  if (line.includes('\n') || !/^[^:\s]+:.+$/.test(line)) {
    throw new WgEasyError("wg-easy's credentials file is not one line of username:password")
  }
  return line
}

/**
 * The box's wg-easy, or null while the box binds none — before the engine's
 * wg-easy module hands this app its API, and on a box without wg-easy. A Mac
 * cannot log in then; nothing else changes.
 */
export function wgEasy(): WgEasy | null {
  const base = env.get('WG_EASY_URL')
  const file = env.get('WG_EASY_CREDENTIALS')
  if (base === undefined || file === undefined) return null
  return makeWgEasy({ base, credentials: () => readCredentials(file) })
}
