import { describe, expect, it } from 'vitest'
import { CALENDAR_TAG } from '../release-tags'
import {
  checkPin,
  LEMONADE_RELEASES,
  type LemonadeRelease,
  type LemonadeTarget,
  pickLemonadeAsset,
} from './lemonade-release'

const TAG = 'v2026.40.0'
const sha = (c: string) => c.repeat(64)
const asset = (name: string, digest: string | null = `sha256:${sha('a')}`) => ({
  name,
  size: 1_000_000,
  digest,
  url: `${LEMONADE_RELEASES}${TAG}/${name}`,
})

// The v2026.40.0 release's assets, as GitHub lists them.
const RELEASE: LemonadeRelease = {
  tag: TAG,
  assets: [
    asset('Lemonade-2026.40.0-Darwin.pkg'),
    asset('lemonade-2026.40.0.tar.gz'),
    asset('lemonade-embeddable-2026.40.0-windows-x64.zip'),
    asset('lemonade-server-2026.40.0-fc43.x86_64.rpm', `sha256:${sha('b')}`),
    asset('lemonade-server-2026.40.0-fc44.x86_64.rpm', `sha256:${sha('c')}`),
    asset('lemonade-server-2026.40.0-fc44.aarch64.rpm'),
    asset('lemonade-server-minimal.msi'),
    asset('lemonade-server_2026.40.0-debian13_amd64.deb', `sha256:${sha('d')}`),
    asset('lemonade-server_2026.40.0-debian13_arm64.deb'),
    asset('lemonade.msi', `sha256:${sha('E')}`),
  ],
}

const on = (t: Partial<LemonadeTarget>): LemonadeTarget => ({
  os: 'linux',
  arch: 'x86_64',
  osName: '',
  osVersion: '',
  ...t,
})

const file = (r: ReturnType<typeof pickLemonadeAsset>) =>
  r.ok ? r.value.url.slice(r.value.url.lastIndexOf('/') + 1) : `refused: ${r.reason}`

describe('the asset a machine installs', () => {
  it('is the full MSI on Windows, never the minimal one, with its digest lowercased', () => {
    const r = pickLemonadeAsset(RELEASE, on({ os: 'windows' }))
    expect(r).toEqual({
      ok: true,
      value: {
        version: TAG,
        url: `${LEMONADE_RELEASES}${TAG}/lemonade.msi`,
        size: 1_000_000,
        sha256: sha('e'),
      },
    })
  })

  it('is the Darwin pkg on macOS', () => {
    expect(file(pickLemonadeAsset(RELEASE, on({ os: 'macos', arch: 'aarch64' })))).toBe(
      'Lemonade-2026.40.0-Darwin.pkg',
    )
  })

  it('is the .deb on Debian and Ubuntu, by architecture', () => {
    expect(file(pickLemonadeAsset(RELEASE, on({ osName: 'Ubuntu', osVersion: '24.04' })))).toBe(
      'lemonade-server_2026.40.0-debian13_amd64.deb',
    )
    expect(
      file(pickLemonadeAsset(RELEASE, on({ osName: 'Debian GNU/Linux', arch: 'aarch64' }))),
    ).toBe('lemonade-server_2026.40.0-debian13_arm64.deb')
  })

  it('is the .rpm built for the Fedora release the machine runs', () => {
    expect(file(pickLemonadeAsset(RELEASE, on({ osName: 'Fedora Linux', osVersion: '43' })))).toBe(
      'lemonade-server-2026.40.0-fc43.x86_64.rpm',
    )
    expect(
      file(
        pickLemonadeAsset(
          RELEASE,
          on({ osName: 'Fedora Linux', osVersion: '44', arch: 'aarch64' }),
        ),
      ),
    ).toBe('lemonade-server-2026.40.0-fc44.aarch64.rpm')
    // fc43 ships no aarch64 build: refused, never the other Fedora's.
    expect(
      pickLemonadeAsset(RELEASE, on({ osName: 'Fedora Linux', osVersion: '43', arch: 'aarch64' }))
        .ok,
    ).toBe(false)
    expect(pickLemonadeAsset(RELEASE, on({ osName: 'Fedora Linux', osVersion: '45' })).ok).toBe(
      false,
    )
  })

  it('refuses a distribution, an architecture or an OS it has no package for', () => {
    expect(file(pickLemonadeAsset(RELEASE, on({ osName: 'NixOS' })))).toMatch(
      /no Lemonade package for NixOS/,
    )
    expect(file(pickLemonadeAsset(RELEASE, on({ osName: '' })))).toMatch(/unnamed distribution/)
    expect(file(pickLemonadeAsset(RELEASE, on({ osName: 'Ubuntu', arch: 'riscv64' })))).toMatch(
      /riscv64/,
    )
    expect(file(pickLemonadeAsset(RELEASE, on({ os: 'freebsd' })))).toMatch(/freebsd/)
  })

  it('refuses an asset GitHub publishes without a SHA-256 digest', () => {
    const bare: LemonadeRelease = { tag: TAG, assets: [asset('lemonade.msi', null)] }
    expect(file(pickLemonadeAsset(bare, on({ os: 'windows' })))).toMatch(/no SHA-256 digest/)
    const md5: LemonadeRelease = { tag: TAG, assets: [asset('lemonade.msi', 'md5:abc')] }
    expect(pickLemonadeAsset(md5, on({ os: 'windows' })).ok).toBe(false)
  })

  it('refuses an asset that is not hosted under its own release', () => {
    const moved: LemonadeRelease = {
      tag: TAG,
      assets: [
        {
          ...asset('lemonade.msi'),
          url: 'https://github.com/evil/lemonade/releases/download/v2026.40.0/lemonade.msi',
        },
      ],
    }
    expect(file(pickLemonadeAsset(moved, on({ os: 'windows' })))).toMatch(/not one of v2026.40.0/)
  })

  it('refuses a release whose tag is not a calendar release', () => {
    expect(
      pickLemonadeAsset({ ...RELEASE, tag: 'candidate-v2026.41.0' }, on({ os: 'windows' })).ok,
    ).toBe(false)
  })
})

describe('a pin', () => {
  const good = {
    version: TAG,
    url: `${LEMONADE_RELEASES}${TAG}/lemonade.msi`,
    size: 10,
    sha256: sha('f'),
  }

  it('is kept as the agent would take it', () => {
    expect(checkPin(good, 'pin')).toEqual(good)
  })

  it('is refused when any part would be refused by the agent', () => {
    expect(() => checkPin({ ...good, version: '10.8.1' }, 'pin')).toThrow(/version/)
    expect(() =>
      checkPin({ ...good, url: `${LEMONADE_RELEASES}v2026.39.0/lemonade.msi` }, 'pin'),
    ).toThrow(/url/)
    expect(() => checkPin({ ...good, url: `${LEMONADE_RELEASES}${TAG}/../x.msi` }, 'pin')).toThrow(
      /url/,
    )
    expect(() => checkPin({ ...good, size: 0 }, 'pin')).toThrow(/size/)
    expect(() => checkPin({ ...good, size: 2 ** 31 + 1 }, 'pin')).toThrow(/size/)
    expect(() => checkPin({ ...good, sha256: 'abc' }, 'pin')).toThrow(/sha256/)
    expect(() => checkPin(null, 'pin')).toThrow(/object/)
  })
})

describe('the calendar tag', () => {
  it('reads Lemonade’s releases and drops its candidates and the old line', () => {
    expect(CALENDAR_TAG.exec('v2026.40.0')?.[1]).toBe('2026.40.0')
    expect(CALENDAR_TAG.exec('v2026.9.12')?.[1]).toBe('2026.9.12')
    expect(CALENDAR_TAG.test('candidate-v2026.41.0')).toBe(false)
    expect(CALENDAR_TAG.test('v10.8.1')).toBe(false)
    expect(CALENDAR_TAG.test('2026.40.0')).toBe(false)
  })
})
