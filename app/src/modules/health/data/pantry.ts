import type { Ctx } from '../../../core/ctx'
import { type VersionGap, versionGap } from '../../../lib/dashboard/github'
import { imageTag } from '../../../lib/dashboard/images'
import { localDay } from '../../../lib/format'
import { getJson } from '../../../lib/http'

// Health › Pantry: Grocy, and the MCP server that puts it on the gateway.
//
// The tab is shown while either half is enabled, so each half answers on its
// own: no Grocy means every Grocy number is null, and no MCP server means its
// version is.

export type PantryData = {
  version: string | null
  releaseDate: string | null
  gap: VersionGap
  missing: number | null
  due: number | null
  overdue: number | null
  expired: number | null
  /** Distinct products with stock on hand. */
  inStock: number | null
  chores: { total: number | null; overdue: number | null }
  tasks: { total: number | null; overdue: number | null }
  mcp: { version: string | null; gap: VersionGap }
}

export async function loadPantry(ctx: Ctx): Promise<PantryData> {
  const h = { headers: { 'GROCY-API-KEY': ctx.secret('GROCY_API_KEY') } }
  const base = ctx.hosts.base('grocy')
  // The box's day, not UTC's: grocy states due dates in local time, and on a
  // box west of UTC a UTC 'today' turns over hours early (at 21:00 on UTC−3)
  // — which marks a whole day's chores and tasks overdue that are not.
  const today = localDay(Date.now())

  const [volatile, info, stock, chores, tasks, mcpVersion] = await Promise.all([
    getJson<{
      missing_products?: unknown[]
      due_products?: unknown[]
      overdue_products?: unknown[]
      expired_products?: unknown[]
    }>(`${base}/api/stock/volatile?days=3`, h),
    getJson<{ grocy_version?: { Version?: string; ReleaseDate?: string } }>(
      `${base}/api/system/info`,
      h,
    ),
    getJson<unknown[]>(`${base}/api/stock`, h),
    getJson<{ next_estimated_execution_time?: string }[]>(`${base}/api/chores`, h),
    getJson<{ due_date?: string; done?: number }[]>(`${base}/api/tasks`, h),
    imageTag('mcp-grocy'),
  ])

  const overdueBy = <T>(rows: T[] | null, at: (r: T) => string | undefined) =>
    rows === null ? null : rows.filter((r) => (at(r) ?? '') !== '' && (at(r) ?? '') < today).length

  const [gap, mcpGap] = await Promise.all([
    versionGap('grocy/grocy', info?.grocy_version?.Version ?? null),
    versionGap('miguelangel-nubla/mcp-grocy', mcpVersion),
  ])

  return {
    version: info?.grocy_version?.Version ?? null,
    releaseDate: info?.grocy_version?.ReleaseDate ?? null,
    gap,
    missing: volatile?.missing_products?.length ?? null,
    due: volatile?.due_products?.length ?? null,
    overdue: volatile?.overdue_products?.length ?? null,
    expired: volatile?.expired_products?.length ?? null,
    inStock: stock?.length ?? null,
    chores: {
      total: chores?.length ?? null,
      overdue: overdueBy(chores, (c) => c.next_estimated_execution_time?.slice(0, 10)),
    },
    tasks: {
      total: tasks === null ? null : tasks.filter((t) => t.done !== 1).length,
      overdue: overdueBy(tasks, (t) => t.due_date?.slice(0, 10)),
    },
    mcp: { version: mcpVersion, gap: mcpGap },
  }
}
