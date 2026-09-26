import { join } from 'node:path'
import { arrayOf, obj, optional, recordOf, str } from '../../../lib/contract/decode'
import { env } from '../../env'
import { type ManifestApp, manifestApp } from '../../nix-manifest'
import { readSnapshot, type SnapshotResult } from '../snapshot'

// /export/apps.json — what only nix knows about the app registry, beside the
// committed apps.json (host/nix-manifest.ts reads both):
//
//   nixManaged          the hand-declared apps — only daedalus itself, from
//                       nix/stacks/daedalus/self.json — which the UI shows and
//                       never edits.
//   operatorSecretApps  apps with a tracked site/vault/apps/<name>-env.sops.
//                       A fact, not a setting: the file existing is the only
//                       thing that decides whether an app gets operator
//                       secrets, so there is nothing for the database to hold
//                       an opinion about.

export type NixApps = {
  nixManaged: Record<string, ManifestApp>
  operatorSecretApps: string[]
}

const shape = obj({
  nixManaged: recordOf(manifestApp),
  operatorSecretApps: optional(arrayOf(str), []),
})

export async function nixApps(): Promise<SnapshotResult<NixApps>> {
  return readSnapshot({
    path: join(env.get('EXPORT_DIR'), 'apps.json'),
    decoder: shape,
    fallback: { nixManaged: {}, operatorSecretApps: [] },
    acceptVersions: [1],
  })
}
