import { Link } from '@tanstack/react-router'
import type { ReactNode } from 'react'
import { ACCESS_WINDOWS, type AccessWindow, WINDOW_SPEC } from '../../lib/access-window'
import { cn } from '../../lib/cn'
import { logTime } from '../../lib/format'
import { useScheme } from '../../lib/scheme'
import { GRAFANA_URL } from '../../lib/site'
import { type Tone, toneStyle } from '../../lib/tone'
import type { AppTabData } from '../../server/registry'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Board, BoardGrid, Stat, StatStrip } from '../viz'
import { BOARD_FOOT, GHOST_BTN, LEDE, STRIP_FOOT, VIZ_EMPTY } from './shared'

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
          <p className={VIZ_EMPTY}>
            {name} is {stage === 'off' ? 'not exposed' : 'internal'}, so there are no remote clients
            to break down.
          </p>
          <p className={BOARD_FOOT}>
            Client IP and country come from the headers Cloudflare adds at the edge, which only
            exist on requests that arrive through the tunnel. LAN requests reach traefik through
            rootlessport, which replaces the source address: every phone, laptop and WireGuard peer
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
    // Deliberately links, not buttons — the window is in the URL, so a chosen
    // range survives a refresh and can be sent to someone.
    <nav className="inline-flex gap-[0.15rem] rounded-[8px] border bg-(--panel) p-[0.15rem]">
      {ACCESS_WINDOWS.map((w) => (
        <Link
          key={w}
          to="/apps/$name"
          params={{ name }}
          search={(prev) => ({ ...prev, tab: 'access' as const, range: w })}
          className={cn(
            'rounded-[6px] px-[0.6rem] py-[0.2rem] text-[0.8rem] text-(--text-muted) no-underline hover:text-foreground hover:no-underline',
            w === range && 'bg-(--raise) text-foreground',
          )}
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
          <p className={VIZ_EMPTY}>Loki did not answer. The access log is the only source here.</p>
        </Board>
      </BoardGrid>
    )
  }

  return (
    // The strip, the board grid and the range picker are plain siblings here,
    // so the column supplies the gap between them — and the strip's own bottom
    // margin, for normal flow, is taken back off so the two do not add up.
    // `.strip` is StatStrip's class in components/viz.tsx.
    <div className="flex flex-col gap-[0.85rem] [&>.strip]:mb-0">
      <div className="flex flex-wrap items-baseline justify-between gap-[0.6rem]">
        {/* No cap on the measure: the sentence names a hostname and a window
            and belongs on one line whenever the page is wide enough for it. */}
        <p className={cn(LEDE, 'm-0 max-w-none flex-[1_1_20rem]')}>
          Remote requests to <code>{hostname}</code> over {spec.prose}, from traefik&rsquo;s access
          log.
        </p>
        {picker}
      </div>

      {access.truncated && (
        <Alert className="mb-[1.35rem] border-info/35 bg-info/7 text-(--text-muted)">
          <AlertDescription>
            More requests than one query can return. The totals below are exact; the breakdowns
            describe the most recent {access.sampled.toLocaleString()}.
          </AlertDescription>
        </Alert>
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
            <p className={VIZ_EMPTY}>
              Nothing arrived through the tunnel in {spec.prose}. The route exists; nothing outside
              is visiting it.
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
                      <span className="text-[0.95rem] leading-none" aria-hidden="true">
                        {c.flag}
                      </span>
                    )}
                    {c.name}
                  </>
                ),
                count: c.count,
              }))}
              total={access.total}
              tone="info"
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
                      <span className="text-[0.95rem] leading-none" aria-hidden="true">
                        {c.flag}
                      </span>
                    )}
                  </>
                ),
                count: c.count,
              }))}
              total={access.total}
              tone="muted"
            />
          </Board>

          <Board title="Top paths" icon="⇢" span={6}>
            <Bars
              rows={access.byPath.map((p) => ({
                key: `${p.path}-${p.status}`,
                label: (
                  <>
                    <StatusCode code={p.status} />
                    <code title={p.path}>{p.path}</code>
                  </>
                ),
                count: p.count,
              }))}
              total={access.total}
              tone="accent"
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
              tone="ok"
            />
          </Board>

          {access.recentRejects.length > 0 && (
            <Board
              title="Recent rejected requests"
              icon="⊘"
              span={12}
              aside={
                <Button asChild variant="outline" size="sm" className={GHOST_BTN}>
                  <a
                    href={`${GRAFANA_URL}/d/s2-security/security?from=now-${range}&to=now`}
                    target="_blank"
                    rel="noreferrer"
                    className="hover:no-underline"
                  >
                    ↗ Grafana
                  </a>
                </Button>
              }
            >
              <div className="flex max-h-[26rem] flex-col gap-[0.15rem] overflow-y-auto text-[0.8rem]">
                {access.recentRejects.map((r, i) => (
                  // Phones: the four-column row has nowhere to go, so the
                  // timestamp drops out and path + client share the width.
                  <div
                    key={`${r.ts}-${String(i)}`}
                    className="grid grid-cols-[8.5rem_3rem_minmax(0,1fr)_auto] items-center gap-[0.7rem] py-[0.18rem] max-[34rem]:grid-cols-[3rem_minmax(0,1fr)] max-[34rem]:gap-y-0"
                  >
                    <time className="font-mono text-[0.74rem] text-(--dim) max-[34rem]:hidden">
                      {logTime(r.ts)}
                    </time>
                    <StatusCode code={r.status} />
                    <span
                      className="min-w-0 overflow-hidden font-mono text-[0.76rem] text-ellipsis whitespace-nowrap"
                      title={`${r.method} ${r.path}`}
                    >
                      <span className="text-(--dim)">{r.method}</span> {r.path}
                    </span>
                    <span
                      className="flex items-center gap-[0.35rem] whitespace-nowrap text-(--text-muted) max-[34rem]:col-start-2"
                      title={r.agent}
                    >
                      {r.flag && <span aria-hidden="true">{r.flag}</span>}
                      <code>{r.ip}</code>
                    </span>
                  </div>
                ))}
              </div>
              <p className={BOARD_FOOT}>
                4xx and 5xx from the tunnel. Most of this is background noise: the internet scans
                every public hostname for WordPress paths within hours of the DNS record appearing,
                and a 404 is the correct answer. The line worth reading is a <em>succeeding</em>{' '}
                request to somewhere unexpected.
              </p>
            </Board>
          )}
        </BoardGrid>
      )}

      <p className={cn(STRIP_FOOT, 'm-0')}>
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
  const scheme = useScheme()
  const src =
    `${GRAFANA_URL}/d-solo/s2-app-access/app-access` +
    `?panelId=1&var-host=${encodeURIComponent(hostname)}` +
    `&from=now-${range}&to=now&theme=${scheme}` +
    // The dashboard's basemap is a variable for exactly this: Esri ships its
    // canvas in a dark and a light grey, and the theme alone does not swap them.
    `&var-basemap=${scheme === 'light' ? 'Light' : 'Dark'}`

  return (
    <Board
      title="Where from"
      icon="🌐"
      span={12}
      aside={
        <Button asChild variant="outline" size="sm" className={GHOST_BTN}>
          <a
            href={`${GRAFANA_URL}/d/s2-app-access/app-access?var-host=${encodeURIComponent(hostname)}&from=now-${range}&to=now`}
            target="_blank"
            rel="noreferrer"
            className="hover:no-underline"
          >
            ↗ Grafana
          </a>
        </Button>
      }
    >
      {/* Fixed height because the iframe's content cannot size its own box
          from outside, and short on phones where a full-height map would push
          everything below it off the screen. */}
      <iframe
        // Keyed on the scheme so a theme change remounts the frame rather than
        // mutating its src, which would add a Grafana entry to the history.
        key={scheme}
        className="block h-96 w-full rounded-[8px] border-0 bg-(--panel-2) [color-scheme:light] dark:[color-scheme:dark] max-[34rem]:h-60"
        src={src}
        title={`Remote requests to ${hostname} by country`}
      />
      <p className={BOARD_FOOT}>
        Rendered by Grafana. A blank map means this browser has no Grafana session yet. Open it{' '}
        <a href={GRAFANA_URL} target="_blank" rel="noreferrer">
          once
        </a>{' '}
        and it will fill in.
      </p>
    </Board>
  )
}

/** Status code, coloured by class. Keyed on the first digit so a code the
    dashboard has never seen still lands in the right bucket. */
const STATUS_TONE: Record<string, Tone> = { '2': 'ok', '3': 'info', '4': 'warn', '5': 'bad' }

function StatusCode({ code }: { code: string }) {
  const tone = STATUS_TONE[code.slice(0, 1)]
  return (
    <span
      className={cn(
        'rounded-[5px] px-[0.35rem] py-[0.05rem] font-mono text-[0.72rem]',
        tone === undefined
          ? 'bg-(--raise) text-(--text-muted)'
          : 'bg-[color-mix(in_srgb,var(--tone)_14%,transparent)] text-(--tone)',
      )}
      style={tone === undefined ? undefined : toneStyle(tone)}
    >
      {code}
    </span>
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
  /** One per board, so four lists side by side stay tellable apart. */
  tone: Tone
}) {
  if (rows.length === 0) return <p className={VIZ_EMPTY}>Nothing recorded.</p>
  // Scaled against the top row, not the grand total: with one dominant source
  // every other bar would round to an invisible sliver, and the point of the
  // bar is to compare the rows to each other.
  const top = Math.max(...rows.map((r) => r.count), 1)
  return (
    <div className="flex flex-col gap-[0.4rem]" style={toneStyle(tone)}>
      {rows.map((r) => (
        // The label column can shrink to nothing before the bar or the count
        // do — a truncated user-agent is readable, a 3px bar is not.
        <div
          key={r.key}
          className="grid grid-cols-[minmax(0,1fr)_5.5rem_auto] items-center gap-[0.65rem] text-[0.84rem] max-[34rem]:grid-cols-[minmax(0,1fr)_3.5rem_auto]"
        >
          <span className="flex min-w-0 items-center gap-[0.4rem] overflow-hidden text-ellipsis whitespace-nowrap [&>code]:overflow-hidden [&>code]:text-ellipsis">
            {r.label}
          </span>
          <span className="h-[6px] overflow-hidden rounded-[3px] bg-(--raise)" aria-hidden="true">
            <span
              className="block h-full rounded-[3px] bg-(--tone)"
              style={{ width: `${String(Math.max(2, (r.count / top) * 100))}%` }}
            />
          </span>
          <span className="text-[0.8rem] tabular-nums whitespace-nowrap text-(--text-muted)">
            {r.count.toLocaleString()}
            {total > 0 && (
              <small className="ml-[0.4rem] text-(--dim)">
                {((r.count / total) * 100).toFixed(0)}%
              </small>
            )}
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
