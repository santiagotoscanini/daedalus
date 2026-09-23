import type { BoardReleases } from './board-releases'

// What the Motherboard tab draws, for this box and for a node alike: the
// board as SMBIOS describes it, the firmware it runs, and the maker's list
// of releases (board-releases.ts). Two readers build it — the host
// snapshot for the box, the agent's telemetry for a node — and one view
// draws it (components/machine-system/board.tsx).

export type BoardInfo = {
  vendor: string | null
  model: string | null
  /** The board revision, where SMBIOS states one ("1.0"; Gigabyte says "x.x"). */
  revision: string | null
  /** "laptop" | "desktop" | … from the chassis, where the machine states it. */
  form: string | null
  bios: { vendor: string | null; version: string | null; date: string | null }
  releases: BoardReleases
}
