// The Access tab's boards: where requests came from, who sent them, what
// they asked for, and what was refused.

import type { ReactNode } from 'react'
import type { AccessWindow } from '../../lib/access-window'
import { cn } from '../../lib/cn'
import { num } from '../../lib/format'
import { useScheme } from '../../lib/scheme'
import { useSite } from '../../lib/site-context'
import { type Tone, toneStyle } from '../../lib/tone'
import { CAPTION, EMPTY, FOOT } from '../tokens'
import { Button } from '../ui/button'
import { Board } from '../viz'
import type { AccessData } from './access'
import { GHOST_BTN } from './shared'

export function CountriesBoard({ access }: { access: AccessData }) {
  return (
    <Board title="Countries" icon="⊕" span={4}>
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
  )
}

export function ClientsBoard({ access }: { access: AccessData }) {
  return (
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
  )
}

export function PathsBoard({ access }: { access: AccessData }) {
  return (
    <Board title="Top paths" icon="⇢" span={12}>
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
  )
}

export function AgentsBoard({ access }: { access: AccessData }) {
  return (
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
  )
}

export function RejectsBoard({
  access,
  grafanaUrl,
  range,
}: {
  access: AccessData
  grafanaUrl: string
  range: AccessWindow
}) {
  return (
    access.recentRejects.length > 0 && (
      <Board
        title="Recent rejected requests"
        icon="⊘"
        span={12}
        aside={
          <Button asChild variant="outline" size="sm" className={GHOST_BTN}>
            <a
              href={`${grafanaUrl}/d/s2-security/security?from=now-${range}&to=now`}
              target="_blank"
              rel="noreferrer"
              className="hover:no-underline"
            >
              ↗ Grafana
            </a>
          </Button>
        }
      >
        <div className="flex max-h-[26rem] flex-col gap-0.5 overflow-y-auto text-[0.8rem]">
          {access.recentRejects.map((r, i) => (
            // Phones: the four-column row has nowhere to go, so the
            // timestamp drops out and path + client share the width.
            <div
              key={`${r.ts}-${String(i)}`}
              className="grid grid-cols-[8.5rem_3rem_minmax(0,1fr)_auto] items-center gap-3 py-1 max-[34rem]:grid-cols-[3rem_minmax(0,1fr)] max-[34rem]:gap-y-0"
            >
              {/* Already formatted by the server — see RejectRow. */}
              <time
                className="font-mono text-[0.75rem] text-muted-foreground max-[34rem]:hidden"
                dateTime={r.ts}
              >
                {r.at}
              </time>
              <StatusCode code={r.status} />
              <span
                className="min-w-0 overflow-hidden font-mono text-[0.75rem] text-ellipsis whitespace-nowrap"
                title={`${r.method} ${r.path}`}
              >
                <span className="text-muted-foreground">{r.method}</span> {r.path}
              </span>
              <span
                className="flex items-center gap-1.5 whitespace-nowrap text-subdued max-[34rem]:col-start-2"
                title={r.agent}
              >
                {r.flag && <span aria-hidden="true">{r.flag}</span>}
                <code>{r.ip}</code>
              </span>
            </div>
          ))}
        </div>
        <p className={FOOT}>
          4xx and 5xx from the tunnel. Most of this is background noise: the internet scans every
          public hostname for WordPress paths within hours of the DNS record appearing, and a 404 is
          the correct answer. The line worth reading is a <em>succeeding</em> request to somewhere
          unexpected.
        </p>
      </Board>
    )
  )
}

/**
 * The App access dashboard's geomap, pinned to one host.
 *
 * A real Grafana panel in an iframe rather than a map rebuilt here. Grafana
 * already owns the projection, the basemap and the ISO-code gazetteer that
 * turns `Cf-Ipcountry` into a coordinate, and none of that is worth a second
 * implementation. The dashboard
 * (`nix/modules/monitoring/assets/dashboards/System/app-access.json`) carries a `$host` variable for exactly this; the same dashboard opened
 * without one is the fleet-wide view.
 *
 * Two things had to be true for this to work, and both live in
 * nix/modules/monitoring: grafana no longer sends `X-Frame-Options: deny`
 * (GF_SECURITY_ALLOW_EMBEDDING), and the narrower `frame-ancestors` CSP that
 * replaced it names daedalus. daedalus and grafana are both under
 * the base domain, so they are same-site and grafana's session cookie rides along
 * with the frame load — no second sign-in, no anonymous access.
 *
 * The caveat is that first load. Grafana auto-logs-in through Pocket ID, and
 * the IdP refuses to be framed, so with no live grafana session the frame
 * comes back empty. A cross-origin frame cannot be inspected for that, so
 * there is no detecting it and swapping in a message — hence the standing
 * link below rather than a conditional one.
 */
export function GeoPanel({ hostname, range }: { hostname: string; range: AccessWindow }) {
  const scheme = useScheme()
  const { grafanaUrl } = useSite()
  const src =
    `${grafanaUrl}/d-solo/s2-app-access/app-access` +
    `?panelId=1&var-host=${encodeURIComponent(hostname)}` +
    `&from=now-${range}&to=now&theme=${scheme}` +
    // The dashboard's basemap is a variable for exactly this: Esri ships its
    // canvas in a dark and a light grey, and the theme alone does not swap them.
    `&var-basemap=${scheme === 'light' ? 'Light' : 'Dark'}`

  return (
    <Board
      title="Where from"
      icon="🌐"
      span={8}
      aside={
        <Button asChild variant="outline" size="sm" className={GHOST_BTN}>
          <a
            href={`${grafanaUrl}/d/s2-app-access/app-access?var-host=${encodeURIComponent(hostname)}&from=now-${range}&to=now`}
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
        className="block h-96 w-full rounded-xl border border-hairline bg-foreground/[0.04] [color-scheme:light] dark:[color-scheme:dark] max-[34rem]:h-60"
        src={src}
        title={`Remote requests to ${hostname} by country`}
      />
      <p className={CAPTION}>
        Rendered by Grafana. A blank map means this browser has no Grafana session yet. Open it{' '}
        <a href={grafanaUrl} target="_blank" rel="noreferrer">
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
        'rounded-[5px] px-1.5 py-px font-mono text-[0.72rem]',
        tone === undefined
          ? 'bg-foreground/[0.06] text-subdued'
          : 'bg-[color-mix(in_oklch,var(--tone)_14%,transparent)] text-(--tone)',
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
  if (rows.length === 0) return <p className={EMPTY}>Nothing recorded.</p>
  // Scaled against the top row, not the grand total: with one dominant source
  // every other bar would round to an invisible sliver, and the point of the
  // bar is to compare the rows to each other.
  const top = Math.max(...rows.map((r) => r.count), 1)
  return (
    <div className="flex flex-col gap-2" style={toneStyle(tone)}>
      {rows.map((r) => (
        // The label column can shrink to nothing before the bar or the count
        // do — a truncated user-agent is readable, a 3px bar is not.
        <div
          key={r.key}
          className="grid grid-cols-[minmax(0,1fr)_5.5rem_auto] items-center gap-3 text-[0.82rem] max-[34rem]:grid-cols-[minmax(0,1fr)_3.5rem_auto]"
        >
          <span className="flex min-w-0 items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap [&>code]:overflow-hidden [&>code]:text-ellipsis">
            {r.label}
          </span>
          <span
            className="h-1.5 overflow-hidden rounded-full bg-foreground/[0.07]"
            aria-hidden="true"
          >
            <span
              className="block h-full rounded-full bg-(--tone)"
              style={{ width: `${String(Math.max(2, (r.count / top) * 100))}%` }}
            />
          </span>
          <span className="text-[0.8rem] tabular-nums whitespace-nowrap text-subdued">
            {num(r.count)}
            {total > 0 && (
              <small className="ml-1.5 text-muted-foreground">
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
