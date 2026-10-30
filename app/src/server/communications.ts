import { readFn } from './fn'

// The Communications page's live values. Proton Mail Bridge's status, re-read
// while the page is open so a sync's progress moves without a reload. The boards
// come from the module loader; this is the file alone, which is cheap to ask
// every few seconds — the release gap and the relay's month of Loki lines are
// not part of it.

export const fetchBridgeReportFn = readFn.handler(async ({ context }) => {
  const { readBridge } = await import('../modules/communications/data/bridge')
  return readBridge(await context.ctx())
})

// The Matrix tab's: the stack helper's status file, re-read the same way, so a
// WhatsApp link made from a terminal shows up while the page is open.
export const fetchMatrixReportFn = readFn.handler(async ({ context }) => {
  const { readMatrix } = await import('../modules/communications/data/matrix')
  return readMatrix(await context.ctx())
})
