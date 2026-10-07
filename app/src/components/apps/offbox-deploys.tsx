// A Vercel project's deployments, as a table: the off-box page's one list
// (routes/apps.offbox.$id.tsx). Split out so the route stays under 400 lines.

import { cn } from '../../lib/cn'
import type { VercelDetail } from '../../lib/external-apps'
import { DASH } from '../../lib/format'
import { Ago } from '../ago'
import { CELL_MONO, CELL_QUIET, TABLE, TABLE_EMPTY, TABLE_HEAD, TABLE_ROW } from '../table'
import { Chip } from '../viz'
import { TabSection } from './section'

/** State · target · message · commit · when · link. */
const VDEP_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[6rem_4rem_minmax(0,1fr)_5rem_5.5rem_1.5rem]',
  '@max-[40rem]/table:grid-cols-[6rem_minmax(0,1fr)_5.5rem]',
)
const VDEP_WIDE = '@max-[40rem]/table:hidden'

const DEPLOY_TONE: Record<string, 'ok' | 'bad' | 'muted'> = {
  READY: 'ok',
  ERROR: 'bad',
  CANCELED: 'muted',
}

const sha = (s: string | null) => (s === null ? DASH : <code>{s.slice(0, 7)}</code>)

export function VercelDeploys({ d }: { d: VercelDetail }) {
  return (
    <TabSection title="Deployments" label="Deployments">
      <ul className={TABLE} aria-label="Deployments">
        {d.deploys.length === 0 ? (
          <li className={TABLE_EMPTY}>None yet.</li>
        ) : (
          <>
            <li className={cn(VDEP_GRID, TABLE_HEAD)}>
              <span>State</span>
              <span className={VDEP_WIDE}>Target</span>
              <span>Message</span>
              <span className={VDEP_WIDE}>Commit</span>
              <span>When</span>
              <span className={VDEP_WIDE} />
            </li>
            {d.deploys.map((x) => (
              <li key={`${x.at}${x.url ?? ''}`} className={cn(VDEP_GRID, TABLE_ROW)}>
                <span>
                  {/* Ready is the norm and reads quiet; an error or a build in flight keeps its chip. */}
                  {x.state === 'READY' ? (
                    <span className="text-[0.78rem] text-muted-foreground">ready</span>
                  ) : (
                    <Chip tone={DEPLOY_TONE[x.state] ?? 'info'}>{x.state.toLowerCase()}</Chip>
                  )}
                </span>
                <span className={cn('text-[0.78rem]', VDEP_WIDE)}>
                  {x.target === 'production' ? (
                    <Chip tone="accent">prod</Chip>
                  ) : (
                    <span className="text-muted-foreground">{x.target ?? DASH}</span>
                  )}
                </span>
                <span className="min-w-0 text-[0.8125rem] text-foreground [overflow-wrap:anywhere]">
                  {x.message ?? DASH}
                  {/* The columns that step away on a phone live here. */}
                  <span className="mt-0.5 hidden text-[0.72rem] text-muted-foreground @max-[40rem]/table:block">
                    {x.target ?? DASH} · {sha(x.sha)}
                    {x.inspectorUrl !== null && (
                      <>
                        {' · '}
                        <a
                          href={x.inspectorUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="relative z-10"
                        >
                          open in Vercel ↗
                        </a>
                      </>
                    )}
                  </span>
                </span>
                <span className={cn(CELL_MONO, VDEP_WIDE)}>{sha(x.sha)}</span>
                <span className={CELL_QUIET}>
                  <Ago at={x.at} />
                </span>
                <span className={cn('text-right', VDEP_WIDE)}>
                  {x.inspectorUrl !== null && (
                    <a
                      href={x.inspectorUrl}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="open in Vercel"
                      className="text-muted-foreground hover:text-foreground"
                    >
                      ↗
                    </a>
                  )}
                </span>
              </li>
            ))}
          </>
        )}
      </ul>
    </TabSection>
  )
}
