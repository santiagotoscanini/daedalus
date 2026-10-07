// Network › Proxy's boards beyond the routes: traffic, certificates, entrypoints.

import { BarList, Board, Columns, Facts, Measures, Progress, Pulse } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { compact, ms, num, since } from '../../../lib/format'
import type { ProxyData } from './proxy'
import { AXIS, CAPTION, EMPTY, FOOT, LIVE, MONO, NOTE, SUB } from './shared'

function codeTone(code: string): 'ok' | 'info' | 'warn' | 'bad' {
  if (code.startsWith('2')) return 'ok'
  if (code.startsWith('3')) return 'info'
  if (code.startsWith('4')) return 'warn'
  return 'bad'
}

/**
 * The digest's per-class ink, spelled out one literal string per class.
 *
 * Never composed at runtime (`code-${c}xx`): Tailwind's scanner cannot see a
 * built name, and the utility has to appear in the source for the rule to be
 * emitted at all. Only the tiny class label carries the colour; the numbers beside it
 * keep the text tokens, so this stays inside the rule that colour never IS the
 * information.
 */
const CODE_INK: Record<string, string> = {
  '2': 'text-success',
  '3': 'text-info',
  '4': 'text-warning',
  '5': 'text-danger',
}

/* What KIND of call, above the caption. Four short pairs on one line: it is a
   breakdown of the chart directly above, not a ranking anyone needs bars for,
   and at four classes a legend would be longer than the data. */
const ENDPOINTS =
  'mb-[0.4rem] flex flex-wrap gap-x-4 gap-y-[0.1rem] [&_b]:font-semibold [&_b]:text-subdued [&_b]:tabular-nums'

// ── The proxy ──────────────────────────────────────────────────────────────

export function TrafficBoard({
  d,
  traffic,
  counts,
  busy,
}: {
  d: ProxyData
  traffic: ProxyData['traffic']
  counts: ProxyData['counts']
  busy: boolean
}) {
  return (
    <Board
      title="Traffic"
      icon="◇"
      span={8}
      aside={
        <span className={LIVE}>
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
        <p className={AXIS}>
          <span>{traffic.daily[0]?.date.slice(5)}</span>
          <span>requests per day</span>
          <span>{traffic.daily[traffic.daily.length - 1]?.date.slice(5)}</span>
        </p>
      )}

      {traffic.byEntrypoint.length > 0 && (
        <>
          <p className={CAPTION}>
            <span className={ENDPOINTS}>
              {traffic.byEntrypoint.map((e) => (
                <span key={e.label}>
                  {e.label === 'websecure' ? 'LAN' : e.label === 'cfweb' ? 'tunnel' : e.label}{' '}
                  <b>{compact(e.value)}</b>
                </span>
              ))}
            </span>
            Split by entrypoint over {d.windowDays} days.
          </p>
          <p className={FOOT}>
            The gap is the shape of this box: almost everything is asked from inside the house, and
            what the tunnel carries is the handful of services deliberately published to the
            internet.
          </p>
        </>
      )}
    </Board>
  )
}

export function CertificatesBoard({ d }: { d: ProxyData }) {
  return (
    <Board
      title="Certificates"
      icon="⌸"
      span={4}
      spanMd={12}
      aside={<span className={NOTE}>the store</span>}
    >
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {d.certs.map((c) => (
          <li
            key={c.cn}
            className="grid min-w-0 grid-cols-[minmax(0,12rem)_minmax(4rem,1fr)_auto] items-center gap-3 text-[0.8rem]"
            title={c.sans.join(', ')}
          >
            <span className={cn(MONO, 'truncate text-muted-foreground')}>{c.cn}</span>
            {/* 90 days is Let's Encrypt's full lifetime, so the bar reads
                as how much of this certificate is left. */}
            <Progress
              pct={Math.min(100, (c.days / 90) * 100)}
              tone={c.days < 14 ? 'bad' : c.days < 30 ? 'warn' : 'ok'}
            />
            <span className="whitespace-nowrap tabular-nums">{c.days.toFixed(0)}d</span>
          </li>
        ))}
      </ul>
      {d.certs.length === 0 && <p className={EMPTY}>no certificate in the store</p>}

      {/* The certificate ↔ route join — see `TraefikData.certs`. */}
      <p className={CAPTION}>
        {d.certs.map((c) => (
          <span key={c.cn} className={ENDPOINTS}>
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

      {/* A quarter-width board, so this keeps only the facts that change
          how the list is read. */}
      <p className={FOOT}>
        The store, not a probe. <b>Every</b> certificate this box serves HTTPS with is here, and one
        wildcard is why that is a short list. Issued over DNS-01 against Cloudflare, so a renewal
        needs nothing reachable from the internet.{' '}
        {d.certs.some((c) => c.covers === 0) && (
          <>
            One covering nothing is a leftover: traefik renews what it holds rather than what is
            declared, so an old certificate stays in <code>acme.json</code> until it is taken out.
          </>
        )}
      </p>
    </Board>
  )
}

export function EntrypointsBoard({ traffic }: { traffic: ProxyData['traffic'] }) {
  return (
    <Board
      title="Where it goes"
      icon="hash"
      span={4}
      spanMd={12}
      aside={<span className={NOTE}>req/min, 1h</span>}
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
  )
}

/**
 * Response codes: one line by default, a bar per code on request.
 *
 * A proxy in front of forty services sees well over a dozen distinct codes a
 * day, and as an always-open bar list that is several times the height of the
 * panel beside it.
 *
 * The summary is not a teaser for the list, it is the answer: the question
 * anybody brings to a status-code panel is "is anything broken", and that is
 * the class totals. The individual codes matter once the answer is yes, and
 * that is what opening it is for.
 */
function CodeBreakdown({ codes }: { codes: { label: string; value: number }[] }) {
  if (codes.length === 0) return <p className={EMPTY}>no traffic</p>

  const classes = (['2', '3', '4', '5'] as const).map((c) => ({
    c,
    total: codes.filter((x) => x.label.startsWith(c)).reduce((n, x) => n + x.value, 0),
  }))
  // Code 0 is traefik's "the client hung up before an answer was written",
  // which is neither a success nor a server fault and belongs in neither bucket.
  const dropped = codes.filter((x) => x.label === '0').reduce((n, x) => n + x.value, 0)

  return (
    <details className="[&>summary]:-mx-2 [&>summary]:flex [&>summary]:cursor-pointer [&>summary]:list-none [&>summary]:flex-col [&>summary]:gap-1 [&>summary]:rounded-lg [&>summary]:px-2 [&>summary]:py-1.5 [&>summary]:transition-colors [&>summary::-webkit-details-marker]:hidden [&>summary]:hover:bg-foreground/[0.04] [&[open]>summary]:bg-foreground/[0.05]">
      <summary>
        <span className={cn(SUB, 'm-0 block')}>Response codes, 24h</span>
        {/* The digest wraps rather than scrolls: four short pairs, and at a
            quarter of the grid it lands on two lines, which is fine. */}
        <span className="flex flex-wrap gap-x-3 gap-y-0.5 text-[0.75rem] text-muted-foreground tabular-nums [&_b]:text-foreground [&_b]:[font-weight:560]">
          {classes
            .filter((x) => x.total > 0)
            .map((x) => (
              <span key={x.c} className={CODE_INK[x.c]}>
                {x.c}xx <b>{compact(x.total)}</b>
              </span>
            ))}
          {dropped > 0 && (
            <span
              className="text-muted-foreground"
              title="Client hung up before an answer was written"
            >
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
      <p className={FOOT}>
        {/* 401 is the gate working, not a fault, and on a box where half the
            routers forward-auth it is one of the commonest codes. */}
        A 401 is usually the gate doing its job, a request arriving without a session on its way to
        the login.
      </p>
    </details>
  )
}
