import type { BoardInfo } from '../../../lib/dashboard/board-info'
import { boardReleases } from '../../../lib/dashboard/board-releases'
import { hostFacts } from '../../../lib/dashboard/host-facts'

// The Motherboard tab: the board from the host snapshot (SMBIOS, read by
// the snapshot script as root), the firmware beside it, and MSI's release
// list from its download host — the one vendor feed that answers this box.

export type BoardData = BoardInfo

export async function loadBoard(): Promise<BoardData> {
  const facts = await hostFacts()
  const board = facts.hardware.board
  const releases = await boardReleases({
    vendor: board.vendor,
    product: board.model,
    biosVersion: board.bios.version,
  })
  return {
    vendor: board.vendor,
    model: board.model,
    revision: board.version,
    form: null,
    bios: board.bios,
    releases,
  }
}
