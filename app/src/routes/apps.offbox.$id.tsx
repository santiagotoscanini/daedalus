import { createFileRoute, Link, notFound } from '@tanstack/react-router'
import { Ago, Until, When } from '../components/ago'
import { PLATFORM_ICONS, SITE_DOT } from '../components/apps/app-card'
import { VercelDeploys } from '../components/apps/offbox-deploys'
import { TabSection } from '../components/apps/section'
import { AppIcon, StateDot } from '../components/controls'
import { GuardedAwait } from '../components/error'
import { Crumbs, PageHead } from '../components/page'
import { BoardsSkeleton } from '../components/skeleton'
import {
  CELL_MONO,
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW,
} from '../components/table'
import { Board, BoardGrid, Chip, Facts, Measures } from '../components/viz'

import { cn } from '../lib/cn'
import type { ExternalApp, PagesDetail, VercelDetail } from '../lib/external-apps'
import { compact, DASH } from '../lib/format'
import { known } from '../lib/known'
import { fetchOffboxDetail, fetchOffboxSite } from '../server/registry'

// One project hosted off the box, as its platform reports it. The identity
// comes from the discovered list (cached, so the head draws at once); the
// rest is the platform asked afresh — the publishes, the domains, and for a
// Vercel project its traffic and firewall — streamed in behind the head.
// Nothing here writes: the box only reads what these platforms say.

export const Route = createFileRoute('/apps/offbox/$id')({
  loader: async ({ params }) => {
    const site = await known(`offbox/${params.id}`, () =>
      fetchOffboxSite({ data: { id: params.id } }),
    )
    if (site === null) throw notFound()
    return { site, detail: fetchOffboxDetail({ data: { id: params.id } }) }
  },
  component: OffboxSite,
  notFoundComponent: () => (
    <>
      <AppsCrumb />
      <PageHead title="Not found">
        Neither GitHub Pages nor Vercel lists a site by that id right now.
      </PageHead>
    </>
  ),
})

function AppsCrumb({ name }: { name?: string }) {
  return (
    <Crumbs>
      <Link to="/apps" className="hover:text-foreground">
        Apps
      </Link>
      {name !== undefined && (
        <>
          {' '}
          <span aria-hidden="true">›</span> {name}
        </>
      )}
    </Crumbs>
  )
}

function OffboxSite() {
  const { site, detail } = Route.useLoaderData()
  return (
    <>
      <AppsCrumb name={site.name} />
      <PageHead
        title={
          <span className="inline-flex items-center gap-3">
            <AppIcon name={site.id} hasIcon={site.hasIcon} size={34} />
            {site.name}
          </span>
        }
        aside={<StateDot state={SITE_DOT[site.state]} label={site.state} />}
      >
        {site.description ?? `Hosted on ${site.platform}.`}
      </PageHead>

      <BoardGrid>
        <Board title="Site" span={site.warnings.length > 0 ? 8 : 12}>
          <Facts
            rows={[
              {
                k: 'served at',
                v: (
                  <a href={`https://${site.host}`} target="_blank" rel="noreferrer">
                    {site.host}
                  </a>
                ),
              },
              {
                k: 'platform',
                v: (
                  <span className="inline-flex items-center gap-1.5">
                    {PLATFORM_ICONS[site.platform]}
                    <a href={site.dashboardUrl} target="_blank" rel="noreferrer">
                      {site.platform}
                    </a>
                  </span>
                ),
              },
              {
                k: 'repository',
                v:
                  site.repo === null ? (
                    DASH
                  ) : (
                    <a href={`https://github.com/${site.repo}`} target="_blank" rel="noreferrer">
                      {site.repo}
                    </a>
                  ),
              },
              {
                k: 'last publish',
                v: site.deployed === null ? DASH : <When at={site.deployed.at} />,
              },
            ]}
          />
        </Board>
        {site.warnings.length > 0 && (
          <Board title="Worth a look" span={4}>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {site.warnings.map((w) => (
                <li key={w}>
                  <Chip tone="warn">{w}</Chip>
                </li>
              ))}
            </ul>
          </Board>
        )}
      </BoardGrid>

      <div className="mt-3">
        <GuardedAwait
          resetKey={site.id}
          promise={detail}
          fallback={<BoardsSkeleton spans={[6, 6]} />}
        >
          {(d) =>
            d === null ? (
              <p className="text-subdued text-[0.85rem]">
                {site.platform} did not answer for this site.
              </p>
            ) : d.kind === 'pages' ? (
              <PagesBoards site={site} d={d.detail} />
            ) : (
              <VercelBoards d={d.detail} />
            )
          }
        </GuardedAwait>
      </div>
    </>
  )
}

const sha = (s: string | null) => (s === null ? DASH : <code>{s.slice(0, 7)}</code>)

function PagesBoards({ site, d }: { site: ExternalApp; d: PagesDetail }) {
  return (
    <>
      <BoardGrid>
        <Board title="Build and HTTPS" span={12}>
          <Facts
            rows={[
              {
                k: 'built by',
                v:
                  d.buildType === 'workflow'
                    ? 'a GitHub Actions workflow'
                    : d.buildType === 'legacy'
                      ? 'a branch build'
                      : DASH,
              },
              {
                k: 'source',
                v: d.source === null ? DASH : <code>{`${d.source.branch} ${d.source.path}`}</code>,
              },
              { k: 'HTTPS enforced', v: d.httpsEnforced ? 'yes' : 'no' },
              {
                k: 'certificate',
                v:
                  d.certificate === null ? (
                    DASH
                  ) : (
                    <>
                      {d.certificate.state}
                      {d.certificate.expiresAt !== null && (
                        <>
                          {' '}
                          · expires {d.certificate.expiresAt.slice(0, 10)}, in{' '}
                          <Until at={d.certificate.expiresAt} />
                        </>
                      )}
                    </>
                  ),
              },
            ]}
          />
        </Board>
      </BoardGrid>
      <TabSection
        title="Publishes"
        label="Publishes"
        aside={
          site.repo !== null && (
            <a
              href={`https://github.com/${site.repo}/deployments/github-pages`}
              target="_blank"
              rel="noreferrer"
            >
              all ↗
            </a>
          )
        }
      >
        <ul className={TABLE} aria-label="Publishes">
          {d.deploys.length === 0 ? (
            <li className={TABLE_EMPTY}>GitHub recorded none.</li>
          ) : (
            <>
              <li className={cn(PUB_GRID, TABLE_HEAD)}>
                <span>State</span>
                <span>Published</span>
                <span>Commit</span>
              </li>
              {d.deploys.map((x) => (
                <li key={`${x.at}${x.sha ?? ''}`} className={cn(PUB_GRID, TABLE_ROW)}>
                  {/* "deployed" is the norm, so it is quiet; anything else is the news. */}
                  <span
                    className={cn(
                      'text-[0.78rem]',
                      x.state === 'deployed' ? 'text-muted-foreground' : 'text-foreground',
                    )}
                  >
                    {x.state}
                  </span>
                  <span className={CELL_QUIET}>
                    <Ago at={x.at} />
                  </span>
                  <span className={CELL_MONO}>{sha(x.sha)}</span>
                </li>
              ))}
            </>
          )}
        </ul>
      </TabSection>
    </>
  )
}

/** State · when · commit, for a site's publishes. */
const PUB_GRID = 'grid items-center gap-x-6 px-5 grid-cols-[minmax(0,1fr)_8rem_6rem]'

function VercelBoards({ d }: { d: VercelDetail }) {
  return (
    <>
      <BoardGrid>
        <Board
          title="Traffic"
          span={4}
          aside={<span className="text-[0.78rem] text-subdued">Web Analytics</span>}
        >
          {d.analytics === null ? (
            <p className="m-0 text-subdued text-[0.82rem]">
              Web Analytics is off for this project, so Vercel counts nothing to show.
            </p>
          ) : (
            <Measures
              items={d.analytics.flatMap((a) => [
                { k: `views · ${String(a.days)} d`, v: compact(a.pageviews) },
                { k: `visitors · ${String(a.days)} d`, v: compact(a.visitors) },
              ])}
            />
          )}
        </Board>
        <Board
          title="Firewall"
          span={4}
          aside={<span className="text-[0.78rem] text-subdued">last 24 h</span>}
        >
          {d.firewall === null ? (
            <p className="m-0 text-subdued text-[0.82rem]">Vercel would not say.</p>
          ) : (
            <>
              <Measures
                items={[
                  { k: 'actions', v: compact(d.firewall.total) },
                  {
                    k: 'IPs blocked',
                    v: compact(d.firewall.blockingIps),
                    tone: d.firewall.blockingIps > 0 ? 'warn' : undefined,
                  },
                  { k: 'IPs challenged', v: compact(d.firewall.challengingIps) },
                ]}
              />
              {Object.keys(d.firewall.byAction).length > 0 && (
                <Facts
                  rows={Object.entries(d.firewall.byAction).map(([k, v]) => ({ k, v: compact(v) }))}
                />
              )}
            </>
          )}
        </Board>
        <Board
          title="Domains"
          span={4}
          aside={d.framework !== null && <Chip tone="muted">{d.framework}</Chip>}
        >
          <Facts
            list
            rows={d.domains.map((x) => ({
              k: x.name,
              v:
                x.redirect !== null
                  ? `redirects to ${x.redirect}`
                  : !x.verified
                    ? 'not verified'
                    : x.misconfigured === true
                      ? 'misconfigured'
                      : 'ok',
            }))}
          />
        </Board>
      </BoardGrid>
      <VercelDeploys d={d} />
    </>
  )
}
