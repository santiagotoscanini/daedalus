// Gateway › Tools models called: the other direction, as a table.

import { FOOT } from '../../../components/tokens'
import { cn } from '../../../lib/cn'
import { ms, num } from '../../../lib/format'
import type { LitellmFacts } from './litellm'
import {
  CELL_MONO,
  CELL_QUIET,
  PHONE_SUB,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
  TableSection,
} from './shared'

/* Server, tool, the tool's own time, calls. On a phone the tool takes the row
   (names wrap, they are long and they are the identifier) with the server and
   the time as its second line; only the count stays a column. */
const TOOL_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[7rem_minmax(0,1fr)_5rem_4rem]',
  '@max-[38rem]/table:grid-cols-[minmax(0,1fr)_3.5rem]',
)
const TOOL_GRID_UNTIMED = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[7rem_minmax(0,1fr)_4rem]',
  '@max-[38rem]/table:grid-cols-[minmax(0,1fr)_3.5rem]',
)
const PHONE_HIDE = '@max-[38rem]/table:hidden'

export function ToolsModelsCalledBoard({ f }: { f: LitellmFacts }) {
  const { data, total } = f
  // A time column only while some tool has one: a column of dashes says
  // nothing a missing column does not.
  const timed = data.mcp.some((t) => t.latencyMs !== null && Number.isFinite(t.latencyMs))
  const grid = timed ? TOOL_GRID : TOOL_GRID_UNTIMED
  return (
    <TableSection
      title="Tools models called"
      note={
        data.mcpServers.length === 0
          ? `MCP, ${String(total.days)} days`
          : data.mcpServers.map((s) => `${s.name} ${String(s.calls)}`).join(' · ')
      }
    >
      <ul className={TABLE} aria-label="Tools models called">
        {data.mcp.length > 0 && (
          <li aria-hidden="true" className={cn(grid, TABLE_HEAD)}>
            <span className={PHONE_HIDE}>Server</span>
            <span>Tool</span>
            {timed && <span className={cn(PHONE_HIDE, 'text-right')}>Time</span>}
            <span className="text-right">Calls</span>
          </li>
        )}
        {data.mcp.length === 0 ? (
          <li className={cn(TABLE_EMPTY, 'py-6')}>No tool calls in the window.</li>
        ) : (
          data.mcp.map((t) => (
            <li key={`${t.server}/${t.tool}`} className={cn(grid, TABLE_ROW)}>
              <span className={cn(CELL_QUIET, PHONE_HIDE, 'truncate')}>{t.server}</span>
              <div className="min-w-0">
                <p
                  className={cn(CELL_MONO, 'm-0 whitespace-normal text-[0.78rem] text-foreground')}
                  title={t.tool}
                >
                  {t.tool}
                </p>
                <p className={PHONE_SUB}>
                  {t.server}
                  {timed && Number.isFinite(t.latencyMs) && t.latencyMs !== null
                    ? ` · ${ms(t.latencyMs)}`
                    : ''}
                </p>
              </div>
              {/* The tool's own time, which is the only latency on this page
                  that is NOT mostly the model server — a tool call is the
                  gateway talking to a container on this box, so tens of
                  milliseconds is what right looks like. */}
              {timed && (
                <span className={cn(CELL_QUIET, PHONE_HIDE, 'text-right')}>{ms(t.latencyMs)}</span>
              )}
              <span className={cn(CELL_QUIET, 'text-right text-foreground')}>{num(t.calls)}</span>
            </li>
          ))
        )}
      </ul>
      <p className={FOOT}>
        The other direction: tools the gateway hands to a model mid-answer, counted when one was
        invoked. A registered server with no calls does not appear, and a tool whose counters were
        reset by a restart shows no time.
      </p>
    </TableSection>
  )
}
