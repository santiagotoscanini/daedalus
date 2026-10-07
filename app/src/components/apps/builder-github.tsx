// Apps › Builder › GitHub: how pushes reach the box and how builds report back.
// Three readings as a strip, then the deliveries and the reports as tables —
// lists under the house section heading, not inside a titled card.

import { Link } from '@tanstack/react-router'
import { sha7 } from '../../lib/build-display'
import { cn } from '../../lib/cn'
import { DASH } from '../../lib/format'
import { appRepo } from '../../lib/site'
import { useSite } from '../../lib/site-context'
import { Ago } from '../ago'
import {
  CELL_MONO,
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_LINK,
  TABLE_ROW,
  TABLE_ROW_LINK,
} from '../table'
import { FOOT } from '../tokens'
import { Stat, StatStrip } from '../viz'
import type { Builder } from './builder'
import { BuildStateChip } from './builds'
import { TabSection } from './section'

type Github = Builder['github']

/** Event · outcome · when. */
const DELIVERY_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_minmax(0,14rem)_6rem]',
)
/** Build · state · check run · deployment · reported. */
const REPORT_GRID = cn(
  'grid items-center gap-x-6 px-5',
  'grid-cols-[minmax(0,1fr)_7rem_6rem_6.5rem_7rem]',
  '@max-[40rem]/table:grid-cols-[minmax(0,1fr)_7rem]',
)
const REPORT_WIDE = '@max-[40rem]/table:hidden'
const LINK_CELL = 'relative z-10 text-[0.78rem] text-muted-foreground hover:text-foreground'

export function GithubSection({ g }: { g: Github }) {
  const site = useSite()
  const inst = g.installation
  const instOk = inst !== null && inst.state === 'ok' && !inst.stale
  return (
    <>
      <TabSection title="GitHub" label="GitHub">
        <p className={cn(FOOT, 'mb-3')}>
          Pushes reach the box through the App’s webhook; a delivery with a bad signature is refused
          before anything reads it. Each build reports back as a check run, and a live one as a
          Deployment.
        </p>
        <StatStrip>
          <Stat
            label="App installation"
            value={inst === null ? 'unknown' : (inst.account?.login ?? inst.state)}
            tone={inst !== null && !instOk ? 'warn' : undefined}
            sub={inst === null ? 'not read yet' : inst.stale ? `${inst.state}, stale` : inst.state}
          />
          <Stat
            label="API budget"
            value={g.rateLimit === null ? DASH : g.rateLimit.remaining.toLocaleString('en-US')}
            sub={
              g.rateLimit === null
                ? undefined
                : `of ${g.rateLimit.limit.toLocaleString('en-US')} left`
            }
          />
          <Stat
            label="Bad signatures"
            value={g.rejected24h === null ? DASH : String(g.rejected24h)}
            tone={g.rejected24h !== null && g.rejected24h > 0 ? 'bad' : undefined}
            sub="last 24 h"
          />
        </StatStrip>
      </TabSection>

      <TabSection
        title="Webhook deliveries"
        label="Webhook deliveries"
        note="A week’s worth is kept."
      >
        <ul className={TABLE} aria-label="Webhook deliveries">
          {g.deliveries.length === 0 ? (
            <li className={TABLE_EMPTY}>None kept.</li>
          ) : (
            <>
              <li className={cn(DELIVERY_GRID, TABLE_HEAD)}>
                <span>Event</span>
                <span>Outcome</span>
                <span className="text-right">Received</span>
              </li>
              {g.deliveries.map((x) => (
                <li key={x.id} className={cn(DELIVERY_GRID, TABLE_ROW)}>
                  <span className="min-w-0 truncate text-foreground">
                    {x.event}
                    {x.action === null ? '' : ` · ${x.action}`}
                  </span>
                  <code className={CELL_MONO}>{x.outcome}</code>
                  <span className={cn(CELL_QUIET, 'text-right whitespace-nowrap')}>
                    <Ago at={x.receivedAt} />
                  </span>
                </li>
              ))}
            </>
          )}
        </ul>
      </TabSection>

      <TabSection title="Reported back" label="Reported back">
        <ul className={TABLE} aria-label="Reported back">
          {g.reported.length === 0 ? (
            <li className={TABLE_EMPTY}>No build has posted a check run yet.</li>
          ) : (
            <>
              <li className={cn(REPORT_GRID, TABLE_HEAD)}>
                <span>Build</span>
                <span>State</span>
                <span className={REPORT_WIDE}>Check run</span>
                <span className={REPORT_WIDE}>Deployment</span>
                <span className={REPORT_WIDE}>Reported</span>
              </li>
              {g.reported.map((b) => (
                <li key={b.id} className={cn(REPORT_GRID, TABLE_ROW, TABLE_ROW_LINK)}>
                  <Link
                    to="/apps/$name/builds/$id"
                    params={{ name: b.app, id: b.id }}
                    className={cn(TABLE_LINK, 'flex min-w-0 items-baseline gap-2')}
                  >
                    <span className="truncate text-foreground [font-weight:560]">{b.app}</span>
                    <code className={CELL_MONO}>{sha7(b.sha)}</code>
                  </Link>
                  <span>
                    {b.state === 'succeeded' ? (
                      <span className="text-[0.78rem] text-muted-foreground">succeeded</span>
                    ) : (
                      <BuildStateChip state={b.state} />
                    )}
                  </span>
                  <span className={REPORT_WIDE}>
                    {b.checkRunId !== null && (
                      <a
                        className={LINK_CELL}
                        href={`https://github.com/${appRepo(site, b.app)}/runs/${String(b.checkRunId)}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        check run ↗
                      </a>
                    )}
                  </span>
                  <span className={REPORT_WIDE}>
                    {b.deploymentId !== null && (
                      <a
                        className={LINK_CELL}
                        href={`https://github.com/${appRepo(site, b.app)}/deployments`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        deployment ↗
                      </a>
                    )}
                  </span>
                  <span
                    className={cn(
                      'text-[0.78rem]',
                      REPORT_WIDE,
                      b.reported ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {b.reported ? 'reported' : 'not reported'}
                  </span>
                </li>
              ))}
            </>
          )}
        </ul>
      </TabSection>
    </>
  )
}
