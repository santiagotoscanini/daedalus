import {
  BarList,
  BigStat,
  Board,
  BoardGrid,
  Chip,
  Facts,
  Progress,
  Pulse,
  Ring,
  StatBand,
  Trend,
  type Tone,
} from '../viz'
import { DASH, bytes, num, pct, rate, since, until } from '../../lib/dashboard/format'
import type { MonitoringData } from '../../server/category'

// The Monitoring page. Everything here is about the watchers rather than the
// watched, so it leads with the two numbers that mean "you would be told":
// how many alert rules are firing, and how many scrape targets are answering.
//
// The layout puts absence first on purpose — down targets, overdue checks and
// worst-uptime endpoints all get named lists, while the healthy majority is a
// single number. A page that renders thirty green rows buries the one red one.

export function MonitoringView({ data }: { data: MonitoringData }) {
  const { alerts, prometheus, loki, probes, checks, grafana } = data

  const firing = alerts.firing ?? 0
  const targetsDown = prometheus.targetsDown ?? 0
  const checksBad = checks === null ? 0 : checks.down + checks.late

  return (
    <>
      <StatBand>
        <BigStat
          label="Alerts firing"
          value={num(alerts.firing)}
          tone={firing > 0 ? 'bad' : 'ok'}
          sub={`of ${num(alerts.rules)} rules${alerts.pending ? `, ${num(alerts.pending)} pending` : ''}`}
        />
        <BigStat
          label="Scrape targets"
          value={num(prometheus.targetsUp)}
          unit="up"
          tone={targetsDown > 0 ? 'bad' : 'ok'}
          sub={targetsDown > 0 ? `${num(prometheus.targetsDown)} not answering` : 'all answering'}
        />
        <BigStat
          label="Uptime"
          value={probes.uptime24h === null ? DASH : `${probes.uptime24h.toFixed(2)}%`}
          tone="info"
          sub={`${num(probes.up)} endpoints probed, 24h`}
        />
        <BigStat
          label="Scheduled jobs"
          value={checks === null ? DASH : String(checks.up)}
          unit="on time"
          tone={checksBad > 0 ? 'warn' : 'ok'}
          sub={checksBad > 0 ? `${String(checksBad)} late or missed` : 'none overdue'}
        />
      </StatBand>

      <BoardGrid>
        <Board
          title="Alert rules"
          icon="⚑"
          span={6}
          aside={<Chip tone={firing > 0 ? 'bad' : 'ok'}>{firing > 0 ? 'firing' : 'quiet'}</Chip>}
        >
          {alerts.active.length === 0 ?
            <p className="viz-empty">
              {alerts.rules === null ?
                'could not reach the ruler'
              : 'nothing firing — every rule is inactive'}
            </p>
          : <ul className="alerts">
              {alerts.active.map((a) => (
                <li key={a.name} className={`alerts-row alerts-${severityTone(a.severity)}`}>
                  <span className="alerts-head">
                    <Pulse on tone={severityTone(a.severity)} />
                    <strong>{a.name}</strong>
                    <Chip tone={severityTone(a.severity)}>{a.severity}</Chip>
                    <em>{a.folder}</em>
                  </span>
                  {a.summary !== '' && <span className="alerts-summary">{a.summary}</span>}
                </li>
              ))}
            </ul>
          }
          <h4 className="board-sub">Rules by folder</h4>
          <BarList items={alerts.byFolder} tone="muted" empty="no rules provisioned" />
          {/* Rules are file-provisioned from stacks/monitoring, so the UI can
              show them but not keep an edit — worth saying next to the count. */}
          <p className="board-foot">
            Provisioned from files. Editing one in Grafana lasts until the next rebuild.
          </p>
        </Board>

        <Board title="Collection" icon="⌁" span={6}>
          <div className="library-split">
            <Ring
              pct={
                prometheus.targetsUp === null || prometheus.targetsDown === null ?
                  null
                : (prometheus.targetsUp / Math.max(1, prometheus.targetsUp + prometheus.targetsDown)) *
                  100
              }
              value={num(prometheus.targetsUp)}
              label="targets up"
              tone={targetsDown > 0 ? 'bad' : 'ok'}
            />
            <Facts
              rows={[
                { k: 'Active series', v: num(prometheus.series) },
                {
                  k: 'Samples',
                  v:
                    prometheus.samplesPerSec === null ?
                      DASH
                    : `${num(prometheus.samplesPerSec)}/s`,
                },
                { k: 'On disk', v: bytes(prometheus.storageBytes) },
                { k: 'Log ingest', v: rate(loki.ingestRate) },
              ]}
            />
          </div>

          {prometheus.down.length > 0 && (
            <>
              <h4 className="board-sub">Not answering</h4>
              <ul className="targets">
                {prometheus.down.map((t) => (
                  <li key={`${t.job}-${t.instance}`} className="targets-row">
                    <span className="targets-name">
                      <Pulse on tone="bad" />
                      {t.job}
                    </span>
                    <code className="targets-instance">{t.instance}</code>
                    <span className="targets-error" title={t.error}>
                      {t.error}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h4 className="board-sub">Slowest scrapes</h4>
          <BarList items={prometheus.slowestScrapes} tone="warn" empty="no scrape timings" />
          <h4 className="board-sub">Series over 7 days</h4>
          <Trend values={prometheus.seriesTrend} tone="info" height={56} />
          {/* A series count that climbs without a new exporter is a cardinality
              leak, and it is the one failure here that never fires an alert. */}
          <p className="board-foot">
            A rising series count with no new exporter is cardinality growth, not more coverage.
          </p>
        </Board>

        <Board
          title="Log pipeline"
          icon="≡"
          span={8}
          aside={<span className="board-note">24 hours, hourly buckets</span>}
        >
          <div className="statband statband-inline">
            <BigStat label="Lines / hour" value={num(loki.lines1h)} tone="info" />
            <BigStat
              label="Errors / hour"
              value={num(loki.byLevel.find((l) => l.label === 'error')?.value)}
              tone="bad"
            />
            <BigStat label="Ingest" value={rate(loki.ingestRate)} tone="muted" />
          </div>
          <h4 className="board-sub">All lines</h4>
          <Trend values={loki.volumeHistory} tone="info" height={64} />
          <h4 className="board-sub">Errors only</h4>
          <Trend values={loki.errorHistory} tone="bad" height={56} />
          <h4 className="board-sub">By level, last hour</h4>
          <BarList
            items={loki.byLevel.map((l) => ({ ...l, tone: levelTone(l.label) }))}
            empty="nothing shipped in the last hour"
          />
          <h4 className="board-sub">Noisiest error sources, 24h</h4>
          <BarList items={loki.noisiest} tone="bad" empty="no errors logged" />
        </Board>

        <Board title="Outside-in probes" icon="◉" span={4}>
          <Facts
            rows={[
              { k: 'Answering', v: num(probes.up) },
              {
                k: 'Not answering',
                v:
                  probes.down !== null && probes.down > 0 ?
                    <span className="text-bad">{probes.down}</span>
                  : num(probes.down),
              },
              { k: 'Uptime 24h', v: pct(probes.uptime24h, 2) },
              {
                k: 'Certificate',
                v:
                  probes.certSoonestDays === null ?
                    DASH
                  : `${probes.certSoonestDays.toFixed(0)}d left`,
              },
            ]}
          />
          <h4 className="board-sub">Lowest uptime, 7 days</h4>
          {probes.worst.length === 0 ?
            <p className="viz-empty">no probe history</p>
          : <ul className="certs">
              {probes.worst.map((w) => (
                <li key={w.name} className="certs-row">
                  <span className="certs-name">{w.name}</span>
                  <Progress
                    pct={w.uptime}
                    tone={w.uptime < 99 ? 'bad' : w.uptime < 99.9 ? 'warn' : 'ok'}
                  />
                  <span className="certs-days">{w.uptime.toFixed(2)}%</span>
                </li>
              ))}
            </ul>
          }
          <h4 className="board-sub">Slowest to answer</h4>
          <BarList items={probes.slowest} tone="warn" empty="no timings" />
          {/* gatus probes the published hostname through traefik, so these
              timings include the proxy and the certificate, not just the app. */}
          <p className="board-foot">
            Measured from outside, through traefik — the number a browser would see.
          </p>
        </Board>

        <Board
          title="Scheduled jobs"
          icon="⏱"
          span={8}
          aside={
            checks === null ?
              <Chip tone="muted">unreachable</Chip>
            : <Chip tone={checksBad > 0 ? 'warn' : 'ok'}>
                {checks.up} up · {checks.down} down · {checks.late} late
              </Chip>
          }
        >
          {checks === null ?
            <p className="viz-empty">could not read the healthchecks roster</p>
          : <ul className="checks">
              {checks.list.map((c) => (
                <li key={c.name} className={`checks-row checks-${checkTone(c.status)}`}>
                  <span className="checks-name">
                    <Pulse on={c.status !== 'up'} tone={checkTone(c.status)} />
                    {c.name}
                  </span>
                  <span className="checks-when">{since(c.lastPingAgo)}</span>
                  <span className="checks-due">
                    {c.dueIn === null ?
                      DASH
                    : c.dueIn < 0 ?
                      <span className="text-bad">overdue {until(-c.dueIn)}</span>
                    : `due in ${until(c.dueIn)}`}
                  </span>
                  <span className="checks-pings">{num(c.pings)} pings</span>
                </li>
              ))}
            </ul>
          }
          {/* The point of a dead-man's-switch is that silence is the failure,
              which is exactly what no other panel on this box can detect. */}
          <p className="board-foot">
            Each job pings on success. Silence past the grace window is the alert —{' '}
            <Chip tone="muted">fleet.monitoredJobs</Chip>
          </p>
        </Board>

        <Board title="Grafana" icon="◍" span={4}>
          <Facts
            rows={[
              { k: 'Dashboards', v: num(grafana.dashboards) },
              { k: 'Data sources', v: num(grafana.datasources) },
              { k: 'Alert rules', v: num(grafana.alertRules) },
            ]}
          />
          <p className="board-foot">
            Dashboards are provisioned with <code>allowUiUpdates: false</code> — the JSON in{' '}
            <code>stacks/monitoring</code> is the source of truth, and a UI edit lasts until the
            next rebuild.
          </p>
        </Board>
      </BoardGrid>
    </>
  )
}

function severityTone(severity: string): Tone {
  if (severity === 'critical') return 'bad'
  if (severity === 'warning') return 'warn'
  return 'info'
}

function levelTone(level: string): Tone {
  if (level === 'error' || level === 'critical') return 'bad'
  if (level === 'warning') return 'warn'
  if (level === 'info') return 'info'
  return 'muted'
}

function checkTone(status: string): Tone {
  if (status === 'down') return 'bad'
  if (status === 'grace') return 'warn'
  if (status === 'up') return 'ok'
  return 'muted'
}
