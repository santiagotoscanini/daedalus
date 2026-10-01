import type { Ctx } from '../../core/ctx'
import type { Report, Roster, StatusDocument } from '../../host/controller/generated'
import { readNode } from '../../host/controller/nodes'
import { getNode, type NodeRow } from '../repo/nodes'
import { readRoster } from './claude'

// The Claude tab (System › Claude) for a machine that is not this box: its
// status document, its session's full Claude report — session names,
// working directories, ids, the environment id, the login's dates — and its
// roster of Claude sessions, as the machine pushed them up its link and the
// controller holds them. No Loki — the machine's own log stays on the machine.

export type NodeClaudeData = {
  node: NodeRow
  /** The status document, when the controller holds one. */
  status: StatusDocument | null
  /** The full report, when the machine's session has sent one. */
  report: Report | null
  /** Why there is no report, when the controller could not say. */
  reportError: string | null
  /** The roster, when the machine's session has sent one. */
  roster: Roster | null
  /** Why there is no roster, or null. */
  rosterMissing: string | null
  /** Why there is no status document, when there is none. */
  error: string | null
}

export async function loadNodeClaude(
  ctx: Pick<Ctx, 'controller'>,
  id: string,
): Promise<NodeClaudeData | null> {
  const read = await readNode(ctx, id)
  const node = await getNode(id, read)
  if (node === null) return null
  const none = {
    node,
    status: null,
    report: null,
    reportError: null,
    roster: null,
    rosterMissing: null,
  }
  const d = read.detail
  if (d === null) return { ...none, error: read.error }
  if (d.status === null) {
    return {
      ...none,
      error: d.connected ? 'connected, but no status has arrived yet' : 'not connected',
    }
  }
  const [report, roster] = await Promise.all([
    ctx.controller.call('nodes.claude', { id }).then(
      (a) => ({ report: a.report, reportError: null }),
      (e: unknown) => ({ report: null, reportError: e instanceof Error ? e.message : String(e) }),
    ),
    readRoster(
      () => ctx.controller.call('nodes.claude_roster', { id }),
      'the machine has not sent a roster since the controller started',
    ),
  ])
  return {
    node,
    status: d.status,
    ...report,
    roster: roster.roster,
    rosterMissing: roster.missing,
    error: null,
  }
}
