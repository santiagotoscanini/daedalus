import { siteIdentity } from '../../host/contract/domains/site'
import { hostFacts } from './host-facts'

// The strip above the box's System tabs: the same head a node wears, so the
// three machines on the picker read alike. Two cached reads — the site
// export for the release and the kernel, the host snapshot for the board —
// and nothing live: what is live is on the tabs below.

export type BoxHead = {
  hostname: string
  /** "NixOS 25.11 (Xantusia)", or as much of it as the export states. */
  os: string
  kernel: string | null
  arch: string
  /** The board's vendor and model, as SMBIOS states them. */
  model: string | null
}

const ARCH: Record<string, string> = { x64: 'x86_64', arm64: 'aarch64' }

export async function loadBoxHead(): Promise<BoxHead> {
  const [site, facts] = await Promise.all([siteIdentity(), hostFacts()])
  const n = site.data.nixos
  const release = n?.release ?? site.data.nixosVersion
  const os = release === null ? 'NixOS' : `NixOS ${release}${n?.codeName ? ` (${n.codeName})` : ''}`
  const board = facts.hardware.board
  // "Micro-Star International Co., Ltd." is a legal name, not a brand.
  const vendor = board.vendor
    ?.replace(/Micro-Star International Co\., Ltd\.?/i, 'MSI')
    .replace(/, (Inc|LLC|Ltd)\.?$/i, '')
  const model = [vendor ?? null, board.model].filter((x) => x !== null).join(' ') || null
  return {
    hostname: site.data.hostname,
    os,
    kernel: facts.kernel ?? n?.kernel ?? null,
    arch: ARCH[process.arch] ?? process.arch,
    model,
  }
}
