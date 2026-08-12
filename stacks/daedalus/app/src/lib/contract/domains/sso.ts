import { join } from 'node:path'
import { arrayOf, obj, optional, str } from '../decode'
import { readSnapshot } from '../snapshot'

// /export/sso.json — the OIDC clients nix DECLARES (fleet.ssoClients, in
// stacks/pocket-id/clients.nix). The convergence job converges but never
// prunes, so the IdP's live list can only grow; diffing it against this is
// the one way to see a client that outlived its stack.

export type DeclaredSsoClient = { id: string; displayName: string }

const shape = obj({
  clients: optional(arrayOf(obj({ id: str, displayName: str })), []),
})

/**
 * `available: false` means the export domain has never been published — a
 * consumer must NOT read the empty list as "nothing is declared", which would
 * make every live client an orphan.
 */
export async function declaredSsoClients(): Promise<{
  available: boolean
  clients: DeclaredSsoClient[]
}> {
  const r = await readSnapshot({
    path: join(process.env.EXPORT_DIR ?? '/export', 'sso.json'),
    decoder: shape,
    fallback: { clients: [] },
    acceptVersions: [1],
  })
  return { available: r.available, clients: r.data.clients }
}
