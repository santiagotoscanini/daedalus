import type { NetworkData } from '../../../lib/dashboard/categories/network'
import { compact, DASH, ms, num, since } from '../../../lib/format'
import { stripBaseDomain } from '../../../lib/site'
import { LogBoard } from '../../logs'
import { Changelog } from '../../release-notes'
import { LinkRow, ServiceHead, verdictOf } from '../../service-head'
import type { Tone } from '../../viz'
import {
  BarList,
  Board,
  BoardGrid,
  Chip,
  Columns,
  Facts,
  Measures,
  Progress,
  Pulse,
} from '../../viz'

function codeTone(code: string): 'ok' | 'info' | 'warn' | 'bad' {
  if (code.startsWith('2')) return 'ok'
  if (code.startsWith('3')) return 'info'
  if (code.startsWith('4')) return 'warn'
  return 'bad'
}

// ── The proxy ──────────────────────────────────────────────────────────────

// One page, one subject. Pocket ID shared this tab and has a category of its
// own now: they were paired because the routing table joins them, and that
// join is still here — the protection column below is drawn from the IdP's
// client list — but a join is a reason for a column, not for a second header
// and a switch above it.
type Proxy = Extract<NetworkData, { tab: 'proxy' }>

/** How each protection class reads, and in what order the table groups them. */
const PROTECTION: Record<
  Proxy['routes'][number]['protection'],
  { title: string; note: string; tone: Tone }
> = {
  app: {
    title: 'The app decides',
    note: 'traefik routes these straight through. Whatever login they have is their own, and this page cannot see it — several of them do have one.',
    tone: 'muted',
  },
  gate: {
    title: 'Behind the gate',
    note: 'A forward-auth middleware. The request goes to Pocket ID first and only reaches the app once it has come back authenticated, so the app never sees an anonymous request at all.',
    tone: 'ok',
  },
  client: {
    title: 'Signs in against Pocket ID itself',
    note: 'No middleware — the app is a registered OIDC client and runs the login itself, which means it also decides what an unauthenticated request gets.',
    tone: 'info',
  },
}

/**
 * traefik: what is published, and what it did with it.
 *
 * The routing table leads because it is the one thing here that exists
 * nowhere else — nix declares the intent, and this is what traefik actually
 * built out of it, including the routers it refused.
 */
export function TraefikView({ d }: { d: Proxy }) {
  const { traffic, counts } = d
  const busy = traffic.rpm !== null && traffic.rpm > 0
  const groups = (['app', 'gate', 'client'] as const)
    .map((p) => ({ p, rows: d.routes.filter((r) => r.protection === p) }))
    .filter((g) => g.rows.length > 0)
  const remote = d.routes.filter((r) => r.remote).length

  return (
    <>
      <ServiceHead
        logo="/icon-traefik.svg"
        name="Traefik"
        version={d.version}
        versionNote={
          d.codename === null ? 'from its own API' : `“${d.codename}” · from its own API`
        }
        verdict={verdictOf(d.gap)}
        compare={[
          {
            k: 'Latest',
            v: d.gap.latest,
            note:
              d.gap.latest === null
                ? 'GitHub did not answer'
                : d.gap.behind.length === 0
                  ? 'this is what is running'
                  : `${String(d.gap.behind.length)} release${d.gap.behind.length === 1 ? '' : 's'} between them`,
          },
          {
            k: 'Read from',
            v: null,
            // Worth stating: every other version on this dashboard is the tag
            // the flake pinned, which is what was ASKED for.
            note: 'the running process, not the tag in the flake',
          },
        ]}
        lede={
          <>
            Every hostname on this box resolves to one process, and this is it. It terminates the
            TLS, picks a container by the name in the request, and — for about half of them — asks
            Pocket ID whether the request should go any further.
          </>
        }
        actions={
          <a
            className="btn btn-primary"
            href="https://traefik.toscanini.me/dashboard/"
            target="_blank"
            rel="noreferrer"
          >
            Open the dashboard ↗
          </a>
        }
      />
      <LinkRow
        links={[
          { label: 'Docs', href: 'https://doc.traefik.io/traefik/' },
          { label: 'GitHub', href: 'https://github.com/traefik/traefik' },
        ]}
      />

      <BoardGrid>
        <Board
          title="What is published, and what protects it"
          icon="⇄"
          span={12}
          aside={
            <span className="board-note">
              {d.routes.length} hostnames · {remote} also off-LAN
            </span>
          }
        >
          {groups.map((g) => (
            <section key={g.p} className="routes-group">
              <h4 className="board-sub">
                {PROTECTION[g.p].title}
                <Chip tone={PROTECTION[g.p].tone}>{g.rows.length}</Chip>
              </h4>
              <ul className="itemlist routes">
                {g.rows.map((r) => (
                  <li key={r.host} title={r.via ?? undefined}>
                    <span className="item-main mono">{stripBaseDomain(r.host)}</span>
                    {/* The chip is the whole point of the row: off-LAN means
                        the internet can ask, and the protection column beside
                        it says what answers. */}
                    {r.remote && <Chip tone="warn">off-LAN</Chip>}
                    {r.disabled && <Chip tone="bad">disabled</Chip>}
                    {/* An em dash is not zero: traefik labels no request
                        counters for its own dashboard's router, and a 0 there
                        would read as "nobody has opened it". */}
                    <span className="item-n">
                      {r.requests === null ? DASH : compact(r.requests)}
                    </span>
                  </li>
                ))}
              </ul>
              <p className="board-foot">{PROTECTION[g.p].note}</p>
            </section>
          ))}

          <p className="board-foot">
            One row per hostname rather than per router, because a name published both on the LAN
            and through the tunnel is two routers for one thing. Read from the configuration traefik
            actually built — not from what the flake asked for, which is the point of looking. The
            count on the right is requests over {d.windowDays} days.
            {counts.errors > 0 && (
              <>
                {' '}
                <b>
                  {num(counts.errors)} piece{counts.errors === 1 ? '' : 's'} of configuration failed
                  to build
                </b>{' '}
                — a router that does not exist answers nothing, quietly.
              </>
            )}
          </p>
        </Board>

        <Board
          title="Traffic"
          icon="◇"
          span={9}
          aside={
            <span className="board-live">
              <Pulse on={busy} tone="accent" />
              {busy ? `${num(traffic.rpm)}/min` : 'idle'}
            </span>
          }
        >
          <Measures
            items={[
              { k: 'open connections', v: num(traffic.open) },
              // p95 of the SERVICE duration, which is the app answering. Named
              // for what it measures so nobody reads it as proxy overhead.
              { k: 'backends, p95', v: ms(traffic.p95Ms) },
              { k: 'routers', v: num(counts.routers) },
              { k: 'config read', v: since(d.config.reloadedAgo) },
            ]}
          />

          <Columns
            points={traffic.daily.map((p) => ({
              label: p.date.slice(5),
              value: p.requests,
              display: `${num(p.requests)} requests`,
            }))}
            height={112}
            empty="nothing scraped yet"
          />
          {traffic.daily.length > 0 && (
            <p className="colaxis">
              <span>{traffic.daily[0]?.date.slice(5)}</span>
              <span>requests per day</span>
              <span>{traffic.daily[traffic.daily.length - 1]?.date.slice(5)}</span>
            </p>
          )}

          {traffic.byEntrypoint.length > 0 && (
            <p className="board-foot">
              <span className="endpoints">
                {traffic.byEntrypoint.map((e) => (
                  <span key={e.label}>
                    {e.label === 'websecure' ? 'LAN' : e.label === 'cfweb' ? 'tunnel' : e.label}{' '}
                    <b>{compact(e.value)}</b>
                  </span>
                ))}
              </span>
              Split by entrypoint over {d.windowDays} days. The gap is the shape of this box: almost
              everything is asked from inside the house, and what the tunnel carries is the handful
              of services deliberately published to the internet.
            </p>
          )}
        </Board>

        <Board
          title="Certificates"
          icon="⌸"
          span={3}
          aside={<span className="board-note">the store</span>}
        >
          <ul className="certs">
            {d.certs.map((c) => (
              <li key={c.cn} className="certs-row" title={c.sans.join(', ')}>
                <span className="certs-name mono">{c.cn}</span>
                {/* 90 days is Let's Encrypt's full lifetime, so the bar reads
                    as how much of this certificate is left. */}
                <Progress
                  pct={Math.min(100, (c.days / 90) * 100)}
                  tone={c.days < 14 ? 'bad' : c.days < 30 ? 'warn' : 'ok'}
                />
                <span className="certs-days">{c.days.toFixed(0)}d</span>
              </li>
            ))}
          </ul>
          {d.certs.length === 0 && <p className="viz-empty">no certificate in the store</p>}

          {/* The join worth making on a page that has both: a certificate is
              only worth renewing if something published matches it, and traefik
              renews whatever is in the store regardless. */}
          <p className="board-foot">
            {d.certs.map((c) => (
              <span key={c.cn} className="endpoints">
                <span>
                  <b>{c.cn}</b>{' '}
                  {c.covers === 0
                    ? 'answers for nothing published here'
                    : `covers ${String(c.covers)} of the ${String(d.routes.length)} published names`}
                </span>
              </span>
            ))}
          </p>

          {d.tls.length > 0 && (
            <Facts
              rows={d.tls.map((t) => ({
                k: `TLS ${t.version}`,
                v: `${t.share.toFixed(t.share > 99 ? 0 : 1)}% of requests`,
              }))}
            />
          )}

          {/* A quarter of the width now, so this keeps the two facts that
              change how the list is read and drops the tour. */}
          <p className="board-foot">
            The store, not a probe — <b>every</b> certificate this box serves HTTPS with is here,
            and one wildcard is why that is a short list. Issued over DNS-01 against Cloudflare, so
            a renewal needs nothing reachable from the internet.{' '}
            {d.certs.some((c) => c.covers === 0) && (
              <>
                One covering nothing is a leftover: traefik renews what it holds rather than what is
                declared, so an old certificate stays in <code>acme.json</code> until it is taken
                out.
              </>
            )}
          </p>
        </Board>

        <Board
          title="Where it goes"
          icon="hash"
          span={3}
          aside={<span className="board-note">req/min, 1h</span>}
        >
          <BarList
            items={traffic.byService.map((s) => ({
              label: s.label,
              value: s.value,
              display: s.value.toFixed(1),
            }))}
            empty="no traffic"
          />
          <CodeBreakdown codes={traffic.byCode} />
        </Board>

        <Changelog gap={d.gap} span={9} />

        {/* No neighbours. cloudflared dials the cfweb entrypoint and is the
            obvious candidate, but it has its own page one tab over — and a
            second copy of a log stream is not a second source. */}
        <LogBoard
          source={{ container: 'traefik' }}
          title="Traefik logs"
          foot={
            <p className="board-foot">
              The service log, not the access log: startup, certificate renewals, configuration
              reloads and the errors behind a router that refused to build. Per-request lines go to
              the access log, which is not shipped here — the metrics above are what that answers.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/**
 * Response codes: one line by default, seventeen bars on request.
 *
 * Seventeen distinct codes in a day is normal for a proxy in front of forty
 * services, and as a bar list it was three times the height of the panel
 * beside it, which is where the hole under the traffic chart came from.
 *
 * The summary is not a teaser for the list, it is the answer: the question
 * anybody brings to a status-code panel is "is anything broken", and that is
 * the class totals. The individual codes matter once the answer is yes, and
 * that is what opening it is for.
 */
function CodeBreakdown({ codes }: { codes: { label: string; value: number }[] }) {
  if (codes.length === 0) return <p className="viz-empty">no traffic</p>

  const classes = (['2', '3', '4', '5'] as const).map((c) => ({
    c,
    total: codes.filter((x) => x.label.startsWith(c)).reduce((n, x) => n + x.value, 0),
  }))
  // Code 0 is traefik's "the client hung up before an answer was written",
  // which is neither a success nor a server fault and belongs in neither bucket.
  const dropped = codes.filter((x) => x.label === '0').reduce((n, x) => n + x.value, 0)

  return (
    <details className="codes">
      <summary>
        <span className="board-sub">Response codes, 24h</span>
        <span className="codes-digest">
          {classes
            .filter((x) => x.total > 0)
            .map((x) => (
              <span key={x.c} className={`code-${x.c}xx`}>
                {x.c}xx <b>{compact(x.total)}</b>
              </span>
            ))}
          {dropped > 0 && (
            <span className="code-0" title="Client hung up before an answer was written">
              no reply <b>{compact(dropped)}</b>
            </span>
          )}
        </span>
      </summary>
      <BarList
        items={codes.map((c) => ({
          label: c.label === '0' ? 'no reply' : c.label,
          value: c.value,
          display: compact(c.value),
          tone: codeTone(c.label),
        }))}
        empty="no traffic"
      />
      <p className="board-foot">
        {/* 401 is the gate working, not a fault, and on a box where half the
            routers forward-auth it is one of the commonest codes. */}
        A 401 is usually the gate doing its job — a request arriving without a session, on its way
        to the login.
      </p>
    </details>
  )
}

/* The audit log's event names were translated here — "signed in", "opened",
   "first time" — for a raw stream that no longer exists. Nothing renders a
   verb now: the aggregates say which verb they counted, and the only events
   still shown are one kind, inside the row they belong to. */
