import { sealAppSecret } from '../../core/vault'
import { readAppSecrets } from '../../host/app-secrets'
import { readEnvSnapshot } from '../../host/env-snapshot'
import { readNixManifest } from '../../host/nix-manifest'
import { requestSecretRemove, requestSecretSet } from '../../host/secret-set-request'
import { getApp } from '../repo/apps'
import type { Result } from '../result'
import { type AppSecretKey, secretKeyError } from './secret-keys'

// One secret value, on demand.
//
// Separate from the app payload so secrets never enter the page: loader data
// is serialised into the HTML, so shipping them and masking with CSS would put
// every database password in view-source — theatre, not concealment. Revealing
// is an explicit request for a named variable, behind the Pocket ID gate like
// the rest of the app.

export async function revealAppEnvVar(data: { name: string; key: string }) {
  // Confirms the app is one this instance manages, so the app name cannot be
  // used to read an arbitrary path out of the snapshot directory.
  const record = await getApp(data.name)
  if (!record) throw new Error(`no app named ${data.name}`)

  const snapshot = await readEnvSnapshot(data.name, new Map())
  const found = snapshot.vars.find((v) => v.key === data.key)
  if (!found) throw new Error(`no variable ${data.key} in ${data.name}`)

  // Only masked variables have anything to reveal: a non-secret value is
  // already in the page payload, so a request for one is not the UI — keep
  // this door exactly as narrow as its purpose.
  if (!found.secret) throw new Error(`${data.key} is not a masked variable`)

  return { value: found.value }
}

// ── the operator-secrets editor ───────────────────────────────────────────
//
// Everything above is about the running container's environment. What follows
// is about the FILE behind part of it: site/vault/apps/<name>-env.sops, the
// operator's own variables for an app.
//
// Write-only, because the container's sops identity is encrypt-only (see
// lib/apps/secret-keys.ts). Add, Replace and Remove are the three verbs there
// can be. Replace is Add under another name — the host merges one key either
// way — so there are two server functions, not three, and the UI's third
// button is a label.
//
// Three guards stand between a form field and `sops --set`, and each is
// deliberately not the last one: the browser checks the name to colour the
// input, `setAppSecret` below refuses it again with the app checked against
// the registry Nix actually built, and the host agent checks both a third time
// against a list Nix generated (stacks/daedalus/host/secret-set.sh). The one
// that matters is the host's — the other two exist so a refusal is a sentence
// on the page rather than a failed unit.

/** Every key in an app's secrets file, with the git facts for each. */
export async function loadAppSecrets(name: string): Promise<AppSecretKey[]> {
  return readAppSecrets(name)
}

/**
 * The apps whose secrets file this box will write, exactly as Nix sees it.
 *
 * The COMMITTED registry, not the database: `VAULT_APP_SECRETS` and
 * `SECRET_APPS` in stacks/daedalus/daedalus.nix are generated from the same
 * `site/apps.json`, so an app created in daedalus but not yet applied has no
 * writable path on the host. Refusing it here says so in a sentence instead of
 * letting the host reject it a second later with less context.
 */
async function writableSecretApps(): Promise<string[]> {
  const manifest = await readNixManifest()
  return Object.keys(manifest.registry.apps)
}

/** The refusal shared by both verbs, or null when the pair is sendable. */
async function requestError(name: string, key: string): Promise<string | null> {
  const bad = secretKeyError(key)
  if (bad !== null) return bad
  if (!(await writableSecretApps()).includes(name)) {
    return `${name} is not in the applied registry, so this box has no secrets file for it yet. Apply first.`
  }
  return null
}

/**
 * Seal one value and ask the host to write it under `key`.
 *
 * The value is sealed BEFORE the request exists and only the ciphertext is
 * ever written down: the bridge directory sits on a snapshotted dataset, so a
 * plaintext that lived there "only for a moment" would live in every hourly
 * snapshot after it. If sealing fails, nothing is dropped at all — the reason
 * comes back as a refusal, which is the honest report, and `Sealed` already
 * guarantees the reason never carries the value.
 */
export async function setAppSecret(data: {
  name: string
  key: string
  value: string
  actor: string
}): Promise<Result<string>> {
  const bad = await requestError(data.name, data.key)
  if (bad !== null) return { ok: false, reason: bad }

  const sealed = await sealAppSecret(data.name, data.value)
  if (!sealed.ok) return sealed

  return {
    ok: true,
    value: await requestSecretSet({
      actor: data.actor,
      app: data.name,
      key: data.key,
      ciphertext: sealed.value,
    }),
  }
}

/**
 * Ask the host to drop `key` from the app's secrets file.
 *
 * Nothing is sealed — there is no value to send — so this is the one verb here
 * that needs no sops at all on this side. The host refuses a key the file does
 * not hold, rather than committing a no-op.
 */
export async function removeAppSecret(data: {
  name: string
  key: string
  actor: string
}): Promise<Result<string>> {
  const bad = await requestError(data.name, data.key)
  if (bad !== null) return { ok: false, reason: bad }

  return {
    ok: true,
    value: await requestSecretRemove({ actor: data.actor, app: data.name, key: data.key }),
  }
}
