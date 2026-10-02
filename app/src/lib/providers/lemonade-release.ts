import type { ProviderPin } from '../../host/controller/generated'
import { CALENDAR_TAG } from '../release-tags'
import type { Result } from '../result'

// Which of a Lemonade release's assets a machine installs, and the pin the
// box hands its agent for it. Pure: the release list is read on the host
// (host/providers/lemonade-release.ts), the machine's OS from its hello.
//
// The agent downloads only from Lemonade's own GitHub releases, keeps the file
// only at the size and SHA-256 named here (agent/src/node/providers/model.rs
// `ProviderInstallParams::check`), and an asset GitHub publishes without a
// digest is refused rather than installed unchecked.

export const LEMONADE_REPO = 'lemonade-sdk/lemonade'
export const LEMONADE_RELEASES = `https://github.com/${LEMONADE_REPO}/releases/download/`
/** The agent's MAX_INSTALLER: 2 GiB. */
const MAX_INSTALLER = 2 ** 31

export type ReleaseAsset = { name: string; size: number; digest: string | null; url: string }
export type LemonadeRelease = { tag: string; assets: ReleaseAsset[] }

/** The machine an asset is picked for, as its hello states it. */
export type LemonadeTarget = {
  /** "windows", "macos", "linux". */
  os: string
  /** "x86_64", "aarch64". */
  arch: string
  /** The distribution on Linux ("Fedora Linux", "Ubuntu"); empty when unknown. */
  osName: string
  /** "43", "24.04"; empty when unknown. */
  osVersion: string
}

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** The asset's name test for this machine, or why it has none. */
function assetFor(version: string, t: LemonadeTarget): Result<(name: string) => boolean> {
  const v = escapeRe(version)
  if (t.os === 'windows') return { ok: true, value: (n) => n === 'lemonade.msi' }
  if (t.os === 'macos') return { ok: true, value: (n) => n === `Lemonade-${version}-Darwin.pkg` }
  if (t.os !== 'linux') return { ok: false, reason: `no Lemonade installer for ${t.os}` }
  const arch =
    t.arch === 'x86_64' || t.arch === 'amd64'
      ? { deb: 'amd64', rpm: 'x86_64' }
      : t.arch === 'aarch64' || t.arch === 'arm64'
        ? { deb: 'arm64', rpm: 'aarch64' }
        : null
  if (arch === null) return { ok: false, reason: `no Lemonade package for ${t.arch}` }
  if (/fedora/i.test(t.osName)) {
    const major = t.osVersion.split('.')[0] ?? ''
    if (!/^\d+$/.test(major)) return { ok: false, reason: 'the machine names no Fedora release' }
    const name = `lemonade-server-${version}-fc${major}.${arch.rpm}.rpm`
    return { ok: true, value: (n) => n === name }
  }
  if (/debian|ubuntu/i.test(t.osName)) {
    const re = new RegExp(`^lemonade-server_${v}-[a-z]+\\d*_${arch.deb}\\.deb$`)
    return { ok: true, value: (n) => re.test(n) }
  }
  return {
    ok: false,
    reason: `no Lemonade package for ${t.osName === '' ? 'an unnamed distribution' : t.osName}`,
  }
}

/**
 * The pin for `release` on this machine: its tag, the asset's URL, size and
 * SHA-256 — or why there is none (no asset for the OS, no digest, a URL that
 * is not the release's own).
 */
export function pickLemonadeAsset(
  release: LemonadeRelease,
  target: LemonadeTarget,
): Result<ProviderPin> {
  const version = CALENDAR_TAG.exec(release.tag)?.[1]
  if (version === undefined) return { ok: false, reason: `${release.tag} is not a release tag` }
  const test = assetFor(version, target)
  if (!test.ok) return test
  const asset = release.assets.find((a) => test.value(a.name))
  if (asset === undefined) {
    return { ok: false, reason: `${release.tag} has no installer for this machine` }
  }
  const sha256 = /^sha256:([0-9a-f]{64})$/i.exec(asset.digest ?? '')?.[1]?.toLowerCase()
  if (sha256 === undefined) {
    return {
      ok: false,
      reason: `${asset.name} carries no SHA-256 digest; an installer that cannot be checked is not installed`,
    }
  }
  try {
    return {
      ok: true,
      value: checkPin({ version: release.tag, url: asset.url, size: asset.size, sha256 }, 'pin'),
    }
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * A pin as the agent would take it, or a throw naming what is wrong: the
 * same rules the agent checks, so a stored pin is one it accepts.
 */
export function checkPin(v: unknown, path: string): ProviderPin {
  if (typeof v !== 'object' || v === null) throw new Error(`${path} must be an object`)
  const { version, url, size, sha256 } = v as Record<string, unknown>
  if (typeof version !== 'string' || !CALENDAR_TAG.test(version)) {
    throw new Error(`${path}.version is not a release tag`)
  }
  const prefix = `${LEMONADE_RELEASES}${version}/`
  if (
    typeof url !== 'string' ||
    !url.startsWith(prefix) ||
    !/^[A-Za-z0-9_+-][A-Za-z0-9._+-]*$/.test(url.slice(prefix.length))
  ) {
    throw new Error(`${path}.url is not one of ${version}'s assets`)
  }
  if (typeof size !== 'number' || !Number.isInteger(size) || size <= 0 || size > MAX_INSTALLER) {
    throw new Error(`${path}.size is not an installer's size`)
  }
  if (typeof sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(sha256)) {
    throw new Error(`${path}.sha256 is not 64 lowercase hex characters`)
  }
  return { version, url, size, sha256 }
}
