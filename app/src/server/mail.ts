import { readFn } from './fn'

// The Email page's one live value: Proton Mail Bridge's status, re-read while
// the page is open so a sync's progress moves without a reload. The boards
// come from the module loader; this is the file alone, which is cheap to ask
// every few seconds — the release gap and the relay's month of Loki lines are
// not part of it.

export const fetchBridgeReportFn = readFn.handler(async ({ context }) => {
  const { readBridge } = await import('../modules/mail/data/bridge')
  return readBridge(await context.ctx())
})
