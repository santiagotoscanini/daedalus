import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ACCESS_WINDOWS, type AccessWindow, WINDOW_SPEC } from '../../lib/access-window'
import { logTime } from '../../lib/format'
import { GRAFANA_URL } from '../../lib/site'
import type { AppTabData } from '../../server/registry'
import { Board, BoardGrid, Stat, StatStrip } from '../viz'

type AccessData = Extract<AppTabData, { kind: 'access' }>['access']

/**
 * Who is reaching this app from the internet.
 *
 * Only the Cloudflare tunnel can answer that. The edge forwards
 * Cf-Connecting-Ip and Cf-Ipcountry, traefik keeps exactly those two headers,
 * and Loki has the access log — so an app published through the tunnel has a
 * real client identity per request. A LAN request has none: rootlessport
 * rewrites the source address on the way in, and every device in the house
 * arrives as the same bridge IP.
 *
 * So this is not "no data yet" for an internal app, it is "there is no such
 * thing", and the empty state says which.
 */
export function Access({
  name,
  hostname,
  stage,
  access,
  range,
}: {
  name: string
  hostname: string
  stage: string
  access: AccessData
  range: AccessWindow
}) {
  if (stage !== 'live') {
    return (
      <BoardGrid>
        <Board title="Access patterns" icon="⊕" span={12}>
          <p className="viz-empty">
            {name} is {stage === 'off' ? 'not exposed' : 'internal'}, so there are no remote clients
            to break down.
          </p>
          <p className="board-foot">
            Client IP and country come from the headers Cloudflare adds at the edge, which only
            exist on requests that arrive through the tunnel. LAN requests reach traefik through
            rootlessport, which replaces the source address — every phone, laptop and WireGuard peer
            in the house shows up as the same bridge IP. Set exposure to <strong>External</strong>{' '}
            above to start collecting this.
          </p>
        </Board>
      </BoardGrid>
    )
  }

  const spec = WINDOW_SPEC[range]
  const okRate = access.total > 0 ? ((access.total - access.rejected) / access.total) * 100 : null
  const picker = (
    <nav className="range">
      {ACCESS_WINDOWS.map((w) => (
        <Link
          key={w}
          to="/apps/$name"
          params={{ name }}
          search={(prev) => ({ ...prev, tab: 'access' as const, range: w })}
          className={w === range ? 'active' : ''}
          // "true", not "page": the active window is the current selection,
          // not the current location — the page is the same either side.
          aria-current={w === range ? 'true' : undefined}
          replace
        >
          {WINDOW_SPEC[w].label}
        </Link>
      ))}
    </nav>
  )

  if (!access.available) {
    return (
      <BoardGrid>
        <Board title="Access patterns" icon="⊕" span={12} aside={picker}>
          <p className="viz-empty">Loki did not answer. The access log is the only source here.</p>
        </Board>
      </BoardGrid>
    )
  }

  return (
    <div className="access">
      <div className="access-head">
        <p className="lede">
          Remote requests to <code>{hostname}</code> over {spec.prose}, from traefik&rsquo;s access
          log.
        </p>
        {picker}
      </div>

      {access.truncated && (
        <div className="banner banner-info">
          More requests than one query can return. The totals below are exact; the breakdowns
          describe the most recent {access.sampled.toLocaleString()}.
        </div>
      )}

      <StatStrip>
        <Stat
          label="Remote requests"
          value={access.total.toLocaleString('en-US')}
          spark={access.series}
          sub={spec.prose}
        />
        <Stat
          label="Unique clients"
          value={access.clients.toLocaleString('en-US')}
          unit="IPs"
          sub="distinct addresses"
        />
        <Stat
          label="Countries"
          value={access.countries.toLocaleString('en-US')}
          sub="by edge header"
        />
        <Stat
          label="Rejected"
          value={access.rejected.toLocaleString('en-US')}
          tone={okRate !== null && okRate < 50 ? 'warn' : undefined}
          sub={okRate === null ? 'nothing to rate' : `${okRate.toFixed(0)}% ok`}
        />
      </StatStrip>

      {access.total === 0 ? (
        <BoardGrid>
          <Board title="Where from" icon="⊕" span={12}>
            <p className="viz-empty">
              Nothing arrived through the tunnel in {spec.prose}. The route exists — this app is
              just not being visited from outside.
            </p>
          </Board>
        </BoardGrid>
      ) : (
        <BoardGrid>
          <GeoPanel hostname={hostname} range={range} />

          <Board title="Countries" icon="⊕" span={6}>
            <Bars
              rows={access.byCountry.map((c) => ({
                key: c.code,
                label: (
                  <>
                    {c.flag && (
                      <span className="flag" aria-hidden="true">
                        {c.flag}
                      </span>
                    )}
                    {c.name}
                  </>
                ),
                count: c.count,
              }))}
              total={access.total}
              tone="geo"
            />
          </Board>

          <Board title="Top clients" icon="◉" span={6}>
            <Bars
              rows={access.byClient.map((c) => ({
                key: c.ip,
                label: (
                  <>
                    <code>{c.ip}</code>
                    {c.flag && (
                      <span className="flag" aria-hidden="true">
                        {c.flag}
                      </span>
                    )}
                  </>
                ),
                count: c.count,
              }))}
              total={access.total}
              tone="client"
            />
          </Board>

          <Board title="Top paths" icon="⇢" span={6}>
            <Bars
              rows={access.byPath.map((p) => ({
                key: `${p.path}-${p.status}`,
                label: (
                  <>
                    <span className={`status status-${p.status.slice(0, 1)}`}>{p.status}</span>
                    <code title={p.path}>{p.path}</code>
                  </>
                ),
                count: p.count,
              }))}
              total={access.total}
              tone="path"
            />
          </Board>

          <Board title="Top user agents" icon="◇" span={6}>
            <Bars
              rows={access.byAgent.map((a) => ({
                key: a.key,
                label: <span title={a.key}>{shortAgent(a.key)}</span>,
                count: a.count,
              }))}
              total={access.total}
              tone="agent"
            />
          </Board>

          {access.recentRejects.length > 0 && (
            <Board
              title="Recent rejected requests"
              icon="⊘"
              span={12}
              aside={
                <a
                  className="btn btn-ghost"
                  href={`${GRAFANA_URL}/d/s2-security/security?from=now-${range}&to=now`}
                  target="_blank"
                  rel="noreferrer"
                >
                  ↗ Grafana
                </a>
              }
            >
              <div className="hits">
                {access.recentRejects.map((r, i) => (
                  <div key={`${r.ts}-${String(i)}`} className="hit">
                    <time>{logTime(r.ts)}</time>
                    <span className={`status status-${r.status.slice(0, 1)}`}>{r.status}</span>
                    <span className="hit-path" title={`${r.method} ${r.path}`}>
                      <span className="hit-method">{r.method}</span> {r.path}
                    </span>
                    <span className="hit-who" title={r.agent}>
                      {r.flag && <span aria-hidden="true">{r.flag}</span>}
                      <code>{r.ip}</code>
                    </span>
                  </div>
                ))}
              </div>
              <p className="board-foot">
                4xx and 5xx from the tunnel. Most of this is background noise — the internet scans
                every public hostname for WordPress paths within hours of the DNS record appearing,
                and a 404 is the correct answer. What is worth reading is a <em>succeeding</em>{' '}
                request to somewhere unexpected, not these.
              </p>
            </Board>
          )}
        </BoardGrid>
      )}

      <p className="strip-foot">
        Only tunnel traffic is counted. Loki keeps 30 days, so that is the longest window there is.
        The map is a Grafana panel from the App access dashboard, filtered to this host; the link on
        the rejected-requests board opens the fleet-wide Security dashboard instead.
      </p>
    </div>
  )
}

/**
 * The Security dashboard's geomap, pinned to one host.
 *
 * A real Grafana panel in an iframe rather than a map rebuilt here. Grafana
 * already owns the projection, the basemap and the ISO-code gazetteer that
 * turns `Cf-Ipcountry` into a coordinate, and none of that is worth a second
 * implementation. `stacks/monitoring/assets/dashboards/System/app-access.json`
 * carries a `$host` variable for exactly this; the same dashboard opened
 * without one is the fleet-wide view.
 *
 * Two things had to be true for this to work, and both live in
 * stacks/monitoring: grafana no longer sends `X-Frame-Options: deny`
 * (GF_SECURITY_ALLOW_EMBEDDING), and the narrower `frame-ancestors` CSP that
 * replaced it names daedalus. daedalus and grafana are both under
 * toscanini.me, so they are same-site and grafana's session cookie rides along
 * with the frame load — no second sign-in, no anonymous access.
 *
 * The caveat is that first load. Grafana auto-logs-in through Pocket ID, and
 * the IdP refuses to be framed, so with no live grafana session the frame
 * comes back empty. A cross-origin frame cannot be inspected for that, so
 * there is no detecting it and swapping in a message — hence the standing
 * link below rather than a conditional one.
 */
function GeoPanel({ hostname, range }: { hostname: string; range: AccessWindow }) {
  const src =
    `${GRAFANA_URL}/d-solo/s2-app-access/app-access` +
    `?panelId=1&var-host=${encodeURIComponent(hostname)}` +
    `&from=now-${range}&to=now&theme=dark`

  return (
    <Board
      title="Where from"
      icon="🌐"
      span={12}
      aside={
        <a
          className="btn btn-ghost"
          href={`${GRAFANA_URL}/d/s2-app-access/app-access?var-host=${encodeURIComponent(hostname)}&from=now-${range}&to=now`}
          target="_blank"
          rel="noreferrer"
        >
          ↗ Grafana
        </a>
      }
    >
      <iframe className="geopanel" src={src} title={`Remote requests to ${hostname} by country`} />
      <p className="board-foot">
        Rendered by Grafana. A blank map means this browser has no Grafana session yet — open it{' '}
        <a href={GRAFANA_URL} target="_blank" rel="noreferrer">
          once
        </a>{' '}
        and it will fill in.
      </p>
    </Board>
  )
}

/** A ranked list with a proportion bar. The ranking is the information. */
function Bars({
  rows,
  total,
  tone,
}: {
  rows: { key: string; label: ReactNode; count: number }[]
  total: number
  tone: string
}) {
  if (rows.length === 0) return <p className="viz-empty">Nothing recorded.</p>
  // Scaled against the top row, not the grand total: with one dominant source
  // every other bar would round to an invisible sliver, and the point of the
  // bar is to compare the rows to each other.
  const top = Math.max(...rows.map((r) => r.count), 1)
  return (
    <div className={`bars bars-${tone}`}>
      {rows.map((r) => (
        <div key={r.key} className="bar">
          <span className="bar-label">{r.label}</span>
          <span className="bar-track" aria-hidden="true">
            <span style={{ width: `${String(Math.max(2, (r.count / top) * 100))}%` }} />
          </span>
          <span className="bar-count">
            {r.count.toLocaleString()}
            {total > 0 && <small>{((r.count / total) * 100).toFixed(0)}%</small>}
          </span>
        </div>
      ))}
    </div>
  )
}

const BROWSER_NAME: Record<string, string> = { Edg: 'Edge', OPR: 'Opera' }
const OS_NAME: Record<string, string> = {
  'Windows NT': 'Windows',
  Macintosh: 'macOS',
  CrOS: 'ChromeOS',
}

/** Browser/bot out of a user-agent string. The full text is in the title. */
function shortAgent(ua: string): string {
  if (ua === '' || ua === '-') return 'none'

  // Crawlers name themselves — Googlebot, GPTBot, bingbot, SemrushBot. Capture
  // the whole token, not the substring "bot", so three different crawlers do
  // not collapse into three identical rows.
  const bot = /([A-Za-z][A-Za-z0-9_.-]*(?:bot|crawler|spider))/i.exec(ua)
  if (bot) return bot[1] ?? 'bot'
  const tool = /^(curl|Wget|python-requests|Go-http-client|okhttp)/i.exec(ua)
  if (tool) return tool[1] ?? ''

  // Edge and Opera both carry a Chrome token as well, and it comes first — so
  // they have to be matched before it or every Edge visit reads as Chrome.
  const branded = /(Firefox|Edg|OPR)\/([0-9]+)/.exec(ua) ?? /(Chrome)\/([0-9]+)/.exec(ua)
  // Safari/604 is the WebKit build, not the browser version; Safari puts its
  // own in Version/.
  const safari = /Version\/([0-9]+)[^)]*Safari\//.exec(ua)

  let label: string
  if (branded) label = `${BROWSER_NAME[branded[1] ?? ''] ?? branded[1] ?? ''} ${branded[2] ?? ''}`
  else if (safari) label = `Safari ${safari[1] ?? ''}`
  else return ua.slice(0, 48)

  const os = /(Windows NT|Macintosh|iPhone|iPad|Android|Linux|CrOS)/.exec(ua)?.[1]
  return os === undefined ? label : `${label} · ${OS_NAME[os] ?? os}`
}
