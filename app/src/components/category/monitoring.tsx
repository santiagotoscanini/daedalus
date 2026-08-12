import type { MonitoringData } from '../../lib/dashboard/categories/monitoring'
import { bytes, compact, DASH, num, pct, since, until } from '../../lib/format'
import { BASE_DOMAIN } from '../../lib/site'
import { LogBoard, type LogNeighbour } from '../logs'
import { Changelog } from '../release-notes'
import { compareOf, Open, ServiceHead, SOURCE_NOTE, verdictOf } from '../service-head'
import { BarList, Board, BoardGrid, Chip, Facts, Measures, Trend } from '../viz'

// The Monitoring pages — a tab per watcher.
//
// Five systems, not one with five panels: Grafana evaluates rules and knows
// nothing about whether prometheus is scraping; prometheus scrapes and knows
// nothing about whether Loki is ingesting; gatus probes from outside and knows
// nothing about either. What they share is that when one stops, the rest keep
// looking fine — which is the argument for tabs rather than a scroll.
//
// Every tab leads with the gap rather than the total. "38 endpoints up" is
// context; "which one is down, and which has the worst week" is the content.
//
// ── read like every other service page ────────────────────────────────────
//
// Artwork, the name, the version running, the verdict on whether that version
// is current, one sentence saying what this watcher is FOR, the link you came
// to click — then the boards, the changelog and the log. Identical to Media,
// Home, AI and Gaming, and these five were the exception: they carried a log
// and nothing else, so the only part of this box whose upgrades you could not
// see from the dashboard was the part that does the watching.

export function MonitoringView({ data }: { data: MonitoringData }) {
  switch (data.tab) {
    case 'alerts':
      return <AlertsView d={data} />
    case 'probes':
      return <ProbesView d={data} />
    case 'metrics':
      return <MetricsView d={data} />
    case 'logs':
      return <LogsView d={data} />
    case 'jobs':
      return <JobsView d={data} />
  }
}

/* ── shared ───────────────────────────────────────────────────────────── */

const SEVERITY: Record<string, 'bad' | 'warn' | 'info'> = {
  critical: 'bad',
  serious: 'bad',
  warning: 'warn',
  info: 'info',
}

/* ── Alerts ───────────────────────────────────────────────────────────── */

type Alerts = Extract<MonitoringData, { tab: 'alerts' }>

function AlertsView({ d }: { d: Alerts }) {
  return (
    <>
      <ServiceHead
        logo="/icon-grafana.svg"
        name="Grafana"
        version={d.grafana.version}
        versionNote="reported by /api/health"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/health — what the running process says')}
        lede={
          <>
            Every alert rule on this box is Grafana-managed and provisioned from files, so this is
            both the thing that draws the graphs and the thing that decides when one of them is
            worth an email. Its own state — users, service accounts, alert history — lives in the{' '}
            <span className="mono">grafana</span> database on the shared cluster, which is the half
            of it that is not in the rebuild trail.
          </>
        }
        actions={<Open name="Grafana" host="grafana" />}
      />

      <BoardGrid>
        <Board
          title={d.active.length === 0 ? 'Nothing firing' : 'Firing now'}
          icon="⚑"
          span={8}
          aside={<span className="board-note">{num(d.rules)} rules</span>}
        >
          {d.active.length === 0 ? (
            <p className="viz-empty">
              No rule is firing or pending. All {num(d.rules)} are evaluating and quiet.
            </p>
          ) : (
            <ul className="itemlist">
              {d.active.map((a) => (
                <li key={`${a.folder}-${a.name}`}>
                  <Chip tone={SEVERITY[a.severity] ?? 'muted'}>{a.severity}</Chip>
                  <span className="item-main" title={a.summary}>
                    {a.name}
                  </span>
                  <span className="item-side">{a.folder}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="board-foot">
            Grafana&rsquo;s ruler, not prometheus&rsquo;s — every rule here is Grafana-managed and
            provisioned from files, so prometheus&rsquo;s own <span className="mono">/rules</span>{' '}
            endpoint is empty and would report zero on a box with {num(d.rules)}. Severity is a
            label on the generated alert instance rather than on the rule, which is why only active
            ones carry it.
          </p>
        </Board>

        <Board title="Rules by folder" icon="rows" span={4}>
          <BarList items={d.byFolder} tone="info" empty="no rules" />
          <p className="board-foot">
            Folders are the provisioning files in{' '}
            <span className="mono">assets/provisioning/alerting/</span>. UI edits do not survive —
            the files are source of truth.
          </p>
        </Board>

        <Board title="Where an alert goes" icon="✉" span={4}>
          <Facts
            rows={[
              { k: 'Contact points', v: num(d.delivery.contactPoints) },
              { k: 'Email', v: <Chip tone="ok">msmtp relay</Chip> },
              { k: 'Grafana', v: d.grafana.version ?? DASH },
              { k: 'Dashboards', v: num(d.grafana.dashboards) },
            ]}
          />
          <p className="board-foot">
            A firing rule reaches a person by email through the same relay smartd and every{' '}
            <span className="mono">OnFailure</span> unit use. There is no phone alert on this box —
            the escalation path is a mailbox.
          </p>
        </Board>

        <Board title="Deliberately silent" icon="🔇" span={8}>
          {/* Not a fault, and the page has to say so — a muted alert path and an
            alert path that was never built look identical from here. */}
          <p className="board-foot">
            Every Home Assistant alert path on this box is <b>switched off on purpose</b>,
            indefinitely. The one that used to fire was the television being turned off, so{' '}
            <span className="mono">media_player</span> and <span className="mono">remote</span> are
            excluded — and the 25 Tuya lights sitting unavailable in the floor are genuinely not
            healthy, which is why the entity-count rule could not simply be re-armed with a higher
            threshold. Grep <span className="mono">HA-MUTED</span> in{' '}
            <span className="mono">/etc/nixos</span> to find every switch. Nothing above will ever
            mention Home Assistant while that holds, and a quiet board is not evidence that it is
            well.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ container: 'grafana' }}
          title="Grafana logs"
          foot={
            <p className="board-foot">
              Rule evaluation, provisioning and notification delivery all land here. An alert that
              should have arrived and did not is either a contact point erroring in this log or a
              rule that never left the pending state.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/* ── Probes ───────────────────────────────────────────────────────────── */

type Probes = Extract<MonitoringData, { tab: 'probes' }>

function ProbesView({ d }: { d: Probes }) {
  return (
    <>
      <ServiceHead
        logo="/icon-gatus.svg"
        name="Gatus"
        version={d.running.version}
        versionNote={SOURCE_NOTE[d.running.source]}
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'the image tag — gatus publishes no version of its own anywhere')}
        lede={
          <>
            The only watcher that looks at this box from OUTSIDE it: every check here is a real
            HTTPS request through traefik and the forward-auth gate, on the same path a browser
            takes. That is what makes it the one system able to notice a certificate, a router or an
            IdP failing, and none of those is visible from a metric scraped on the inside.
          </>
        }
        // `status`, not `gatus`: the published label differs from the attribute
        // name here, as it does for Pocket ID and Open WebUI. Deriving one from
        // the other is how this dashboard grows links that 404.
        actions={<Open name="Gatus" host="status" />}
      />

      <BoardGrid>
        <Board
          title={d.failing.length === 0 ? 'Everything answering' : 'Not answering'}
          icon="◎"
          span={8}
          aside={
            <span className="board-note">
              {num(d.up)} up · {num(d.down)} down
            </span>
          }
        >
          {d.failing.length === 0 ? (
            <p className="viz-empty">All {num(d.up)} endpoints answered their last probe.</p>
          ) : (
            <ul className="itemlist">
              {d.failing.map((f) => (
                <li key={f}>
                  <Chip tone="bad">down</Chip>
                  <span className="item-main">{f}</span>
                </li>
              ))}
            </ul>
          )}

          <h4 className="board-sub">Worst week</h4>
          <ul className="itemlist">
            {d.worst.map((w) => (
              <li key={w.name}>
                <span className="item-main">{w.name}</span>
                <span className="item-n">{pct(w.uptime, 2)}</span>
              </li>
            ))}
          </ul>

          <p className="board-foot">
            Ranked by the WORST seven days rather than the average, because an average over
            thirty-eight endpoints hides the one that is broken. Some of what you see here is not an
            outage: traefik dials the *arrs at a port published out of gluetun&rsquo;s rootless
            namespace, where a new connection stalls about ten seconds one time in forty, and gatus
            times out at ten. Roughly 2% of those probes fail against a service answering every
            request anybody actually made — which is why the tab dots elsewhere on this dashboard
            require three minutes of silence before they turn red.
          </p>
        </Board>

        <Board title="Certificates" icon="key" span={4}>
          <Facts
            rows={[
              { k: 'Soonest expiry', v: d.cert.days === null ? DASH : `${num(d.cert.days)} days` },
              { k: 'On', v: d.cert.host ?? DASH },
              { k: '24h uptime', v: pct(d.uptime24h, 2) },
            ]}
          />
          <p className="board-foot">
            One entrypoint-level wildcard covers <span className="mono">*.{BASE_DOMAIN}</span>, so
            this is effectively one certificate for every hostname on the box. Renewal is DNS-01
            through Cloudflare and automatic — a number falling below thirty means lego is failing,
            and the store is a single file that is in no backup.
          </p>
        </Board>

        <Board title="Slowest to answer" icon="⏱" span={4}>
          <BarList items={d.slowest} tone="warn" empty="nothing measured" />
          <p className="board-foot">
            Probed from outside over HTTPS, so this includes TLS, the proxy and the forward-auth
            round trip — not just the app.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ container: 'gatus' }}
          title="Gatus logs"
          foot={
            <p className="board-foot">
              Gatus fetches the OIDC discovery document while starting and panics if it is not being
              served yet, which is why it is one of the containers gated behind a bounded probe of
              the real discovery URL rather than merely ordered after Pocket ID — see{' '}
              <span className="mono">fleet.sso.discoveryConsumers</span>.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/* ── Metrics ──────────────────────────────────────────────────────────── */

type Metrics = Extract<MonitoringData, { tab: 'metrics' }>

/**
 * The two things that produce most of what prometheus stores.
 *
 * Neither has a page anywhere and neither ever will — they are exporters, not
 * services anybody opens — but both are exactly the "you would come looking
 * here when the panel above went wrong" case that `LogNeighbour` is for. Half
 * of the System category is drawn from node-exporter and the other half from
 * host-liveness-exporter, and until this existed neither one's log was
 * reachable from anywhere in this dashboard.
 */
const SCRAPE_NEIGHBOURS: readonly LogNeighbour[] = [
  {
    source: { container: 'node-exporter' },
    label: 'node-exporter',
    role: 'the host’s own numbers',
    note: 'CPU, memory, filesystems, the NIC counters and the pressure stall figures — everything the System › Host and Memory tabs draw. It runs on --network=host because it reads the real /proc, /sys and interfaces, which is also why it is the one target here published on a port rather than dialled over a bridge.',
  },
  {
    source: { unit: 'host-liveness-exporter.service' },
    label: 'host-liveness-exporter',
    role: 'per-container metrics, and the uplink probe',
    note: 'A timer, not a daemon: every 60s it walks the rootless cgroup tree that no packaged exporter can see (container CPU, memory, PIDs and OOM kills for all ~75 containers), pings the gateway and the internet for the Network › General dot, and writes a textfile for node-exporter to pick up. A metric here that stops moving is this not having run, and it looks identical to a container that is idle.',
  },
]

function MetricsView({ d }: { d: Metrics }) {
  return (
    <>
      <ServiceHead
        logo="/icon-prometheus.svg"
        name="Prometheus"
        version={d.version}
        versionNote="reported by /api/v1/status/buildinfo"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/v1/status/buildinfo')}
        lede={
          <>
            Every number on this dashboard that is a rate, a trend or a seven-day anything came from
            here. It publishes no host port and runs without{' '}
            <span className="mono">--web.enable-lifecycle</span>, and its scrape list is generated
            from nix — each stack contributes its own{' '}
            <span className="mono">fleet.prometheusScrapes</span>, so a target that is missing is a
            stack that never declared one rather than a file somebody forgot to edit.
          </>
        }
        actions={<Open name="Prometheus" host="prometheus" />}
      />

      <BoardGrid>
        <Board
          title={d.down.length === 0 ? 'Every target reporting' : 'Targets not reporting'}
          icon="◉"
          span={8}
          aside={
            <span className="board-note">
              {num(d.targetsUp)} up · {num(d.targetsDown)} down
            </span>
          }
        >
          {d.down.length === 0 ? (
            <p className="viz-empty">All {num(d.targetsUp)} scrape targets answered.</p>
          ) : (
            <ul className="itemlist">
              {d.down.map((t) => (
                <li key={`${t.job}-${t.instance}`}>
                  <Chip tone="bad">{t.job}</Chip>
                  <span className="item-main mono">{t.instance}</span>
                  <span className="item-side">{t.error}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="board-foot">
            Read from prometheus&rsquo;s own API rather than from{' '}
            <span className="mono">up == 0</span>, because only the API carries the last error — the
            difference between &ldquo;prometheus cannot reach this&rdquo; and &ldquo;this answered
            401&rdquo;. Both look like a dead target on a graph.
          </p>
        </Board>

        <Board title="Storage" icon="grid" span={4}>
          <Facts
            rows={[
              { k: 'Series in head', v: compact(d.series) },
              // compact, not `rate` — that formatter is BYTES per second, and a
              // sample count wearing a KB suffix is a wrong number, not a wrong
              // unit.
              {
                k: 'Samples/sec',
                v: d.samplesPerSec === null ? DASH : `${compact(d.samplesPerSec)}/s`,
              },
              { k: 'On disk', v: bytes(d.storageBytes) },
              {
                k: 'Retention',
                v: d.retention.days === null ? DASH : `${num(d.retention.days)} days`,
              },
              {
                k: 'Oldest sample',
                v:
                  d.retention.oldestDays === null
                    ? DASH
                    : `${num(d.retention.oldestDays)} days back`,
              },
            ]}
          />
          <p className="board-foot">
            The two retention rows are the reading: if the oldest sample is well short of the
            window, the disk cap bit before the time limit did and the history is shorter than
            configured.
          </p>
        </Board>

        <Board title="Series, seven days" icon="panels" span={8}>
          <Trend values={d.seriesTrend} tone="accent" height={110} />
          <p className="board-foot">
            Active series is what memory here is actually spent on. A step up that never comes back
            down is a new label with unbounded values — the way a TSDB usually gets into trouble,
            and the thing a total sample count would not show.
          </p>
        </Board>

        <Board title="Slowest scrapes" icon="⏱" span={4}>
          <BarList items={d.slowestScrapes} tone="warn" empty="nothing measured" />
          <p className="board-foot">
            A scrape that approaches its interval is a target about to start missing samples.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ container: 'prometheus' }}
          title="Prometheus logs"
          neighbours={SCRAPE_NEIGHBOURS}
        />
      </BoardGrid>
    </>
  )
}

/* ── Logs ─────────────────────────────────────────────────────────────── */

type Logs = Extract<MonitoringData, { tab: 'logs' }>

function LogsView({ d }: { d: Logs }) {
  return (
    <>
      <ServiceHead
        logo="/icon-loki.svg"
        name="Loki"
        version={d.loki.version}
        versionNote="reported by /loki/api/v1/status/buildinfo"
        verdict={verdictOf(d.loki.gap)}
        compare={compareOf(d.loki.gap, 'from /loki/api/v1/status/buildinfo')}
        lede={
          <>
            Where every log panel on this dashboard gets its lines, including the one at the bottom
            of this page. Alloy tails journald and ships here; this stores and answers. It publishes
            no hostname of its own — it is reached over the monitoring bridge — which is why this
            tab&rsquo;s dot is the one grey circle on the row: there is nothing here for gatus to
            probe from outside, which is a different claim from down.
          </>
        }
      />

      <BoardGrid>
        <Board
          title="Volume"
          icon="logs"
          span={8}
          aside={<span className="board-note">{compact(d.lines1h)} lines in the last hour</span>}
        >
          <Trend values={d.volumeHistory} tone="info" height={90} />
          <h4 className="board-sub">Errors only, same day</h4>
          <Trend values={d.errorHistory} tone="bad" height={70} />
          <Measures
            items={[
              { k: 'lines 1h', v: compact(d.lines1h) },
              { k: 'ingest', v: `${bytes(d.ingestRate)}/s` },
            ]}
          />
          <p className="board-foot">
            Two lines rather than one chart: total volume moves with how busy the box is and says
            nothing on its own, while the error line is the one worth a glance. A spike in the
            second without a spike in the first is a service failing rather than a service working
            hard.
          </p>
        </Board>

        <Board title="By level" icon="◱" span={4}>
          <BarList items={d.byLevel} tone="info" empty="nothing labelled" />
        </Board>

        <Board title="Noisiest errors, 24h" icon="warn" span={4}>
          <BarList items={d.noisiest} tone="warn" empty="no errors" />
          <p className="board-foot">
            Host journal lines carry <span className="mono">unit</span> rather than{' '}
            <span className="mono">container</span>, so they group together rather than appearing as
            a missing name.
          </p>
        </Board>

        <Board
          title="Coverage"
          icon="▣"
          span={8}
          aside={
            d.unregistered !== null && d.unregistered > 0 ? (
              <Chip tone="warn">{compact(d.unregistered)} unlabelled</Chip>
            ) : (
              <Chip tone="ok">all labelled</Chip>
            )
          }
        >
          <BarList items={d.byStack} tone="accent" empty="no stack labels" />
          <p className="board-foot">
            Every container&rsquo;s lines are labelled with the stack it belongs to, generated from{' '}
            <span className="mono">fleet.logStacks</span>; an unregistered container falls back to
            its own name. The <span className="mono">adhoc</span> bucket is the exception worth
            watching — it catches containers started by hand rather than by a unit, which once
            minted 77 phantom services in Loki before it existed.
          </p>
        </Board>

        {/* Two, because this tab has two subjects on two release cycles. The
          same shape the Downloaders and Cleanup tabs use for the services
          they hold side by side. */}
        <Changelog
          gap={d.loki.gap}
          span={6}
          aside={<span className="board-note">grafana/loki</span>}
        />
        <Changelog
          gap={d.alloy.gap}
          span={6}
          aside={
            <span className="board-note">grafana/alloy · {d.alloy.running.version ?? DASH}</span>
          }
          foot={
            <p className="board-foot">
              The collector, on its own release cycle. Its version is read{' '}
              {SOURCE_NOTE[d.alloy.running.source]} rather than from the process — alloy shares a
              stack with Loki here and publishes no hostname, so there is nothing to ask.
            </p>
          }
        />

        <LogBoard
          source={{ container: 'loki' }}
          title="Loki logs"
          neighbours={[
            {
              source: { container: 'alloy' },
              label: 'Alloy',
              role: 'the collector that fills it',
              note: 'Tails journald, applies the relabel rules generated from fleet.logStacks, and pushes to Loki. This is the half that touches the journal, so “lines stopped arriving” is answered here rather than next door — a rejected push, a dropped stream or a relabel rule that stopped matching all appear in this log and in no other.',
            },
          ]}
          foot={
            <p className="board-foot">
              Loki&rsquo;s own stream, with the collector one disclosure below it — they were one
              panel under the shared <span className="mono">stack=logging</span> label, which
              interleaved two services whose failures mean opposite things. Note that Loki refuses a
              query longer than about thirty days: a wider range on any log panel in this dashboard
              returns an error rather than fewer results.
            </p>
          }
        />
      </BoardGrid>
    </>
  )
}

/* ── Jobs ─────────────────────────────────────────────────────────────── */

type Jobs = Extract<MonitoringData, { tab: 'jobs' }>

function JobsView({ d }: { d: Jobs }) {
  return (
    <>
      <ServiceHead
        logo="/icon-healthchecks.svg"
        name="Healthchecks"
        version={d.running.version}
        versionNote={SOURCE_NOTE[d.running.source]}
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'the image tag — its API is about checks, not about itself')}
        lede={
          <>
            The only watcher here that reports the ABSENCE of an event. Everything else on this box
            notices something going wrong; this notices something that stopped happening, which is
            the failure a scheduled job actually has — a timer that was disabled, never fired, or
            whose service was renamed.
          </>
        }
        // `hc`, not `healthchecks` — see the note on Gatus above.
        actions={<Open name="Healthchecks" host="hc" />}
      />

      <BoardGrid>
        <Board
          title="Scheduled jobs"
          icon="⏲"
          span={8}
          aside={
            <span className="board-note">
              {num(d.jobs.length)} declared · {num(d.emailOnly)} by mail only
            </span>
          }
        >
          <ul className="itemlist">
            {d.jobs.map((j) => (
              <li key={j.unit}>
                <span className="item-main mono">{j.unit}</span>
                {j.slug === null ? (
                  <Chip tone="muted">mail on failure</Chip>
                ) : j.status === null ? (
                  <Chip tone="bad">slug unknown</Chip>
                ) : j.status === 'up' ? (
                  <Chip tone="ok">pinging</Chip>
                ) : j.status === 'grace' ? (
                  <Chip tone="warn">late</Chip>
                ) : (
                  <Chip tone="bad">{j.status}</Chip>
                )}
                <span className="item-side">
                  {j.slug === null ? '' : (since(j.lastPingAgo) ?? '')}
                </span>
              </li>
            ))}
          </ul>
          <p className="board-foot">
            The registry from <span className="mono">fleet.monitoredJobs</span>, joined to what
            healthchecks actually knows. The two are different guarantees: <b>mail on failure</b>{' '}
            means a run that fails tells you, and <b>pinging</b> means a run that stops happening at
            all tells you. Only the second catches a timer that was disabled, never fired, or whose
            service was renamed — which is the failure a scheduled job actually has.{' '}
            {num(d.emailOnly)} of the {num(d.jobs.length)} here are mail-only, deliberately: for a
            job that runs on every rebuild, &ldquo;it did not run&rdquo; is not a fault.
          </p>
        </Board>

        <Board
          title="Dead-man's switches"
          icon="clock"
          span={4}
          aside={
            d.summary === null ? undefined : (
              <span className="board-note">
                {num(d.summary.up)} up · {num(d.summary.late)} late · {num(d.summary.down)} down
              </span>
            )
          }
        >
          {d.checks.length === 0 ? (
            <p className="viz-empty">healthchecks did not answer</p>
          ) : (
            <ul className="itemlist">
              {d.checks.map((c) => (
                <li key={c.name}>
                  <span className="item-main">{c.name}</span>
                  <span className="item-side">
                    {c.status === 'up' ? (
                      <Chip tone="ok">up</Chip>
                    ) : c.status === 'grace' ? (
                      <Chip tone="warn">late</Chip>
                    ) : (
                      <Chip tone="bad">{c.status}</Chip>
                    )}
                  </span>
                  <span className="item-side">
                    {c.dueIn === null ? DASH : c.dueIn < 0 ? 'overdue' : `due ${until(c.dueIn)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="board-foot">
            Each job pings on success; healthchecks alerts when a ping does not arrive inside the
            period plus its grace. <b>Late</b> is the state worth seeing — it is inside the grace
            window and has not become an alert yet.
          </p>
        </Board>

        {d.orphaned.length > 0 && (
          // The join's whole reason for existing. Neither system can find this
          // on its own: nix believes the job is watched, healthchecks has never
          // heard of it, and nothing compares the two.
          <Board title="Armed but never fired" icon="warn" span={12}>
            <ul className="itemlist">
              {d.orphaned.map((u) => (
                <li key={u}>
                  <Chip tone="bad">no check</Chip>
                  <span className="item-main mono">{u}</span>
                </li>
              ))}
            </ul>
            <p className="board-foot">
              These declare a healthchecks slug that healthchecks does not have a check for — so the
              dead-man&rsquo;s switch reads as armed in nix and does not exist. A check is created
              by its first ping, which means either the job has never once succeeded, or the ping is
              failing silently. Neither system can see this alone: nix knows the intent,
              healthchecks knows the reality, and this is the only place they are compared.
            </p>
          </Board>
        )}

        <Changelog
          gap={d.gap}
          span={12}
          foot={
            <p className="board-foot">
              Its releases are numbered with two segments — <span className="mono">v4.2</span>, not{' '}
              <span className="mono">v4.2.0</span> — so this panel matches them with its own
              pattern; the shared three-segment one would report a project with sixty releases as
              having none. A tag ahead of the newest RELEASE is normal here and is why the verdict
              can read &ldquo;current&rdquo; against an empty list: the image is built from the git
              tag, and the release note follows it by a few days.
            </p>
          }
        />

        <LogBoard
          source={{ container: 'healthchecks' }}
          title="Healthchecks logs"
          neighbours={[
            {
              source: { unit: 'hc-ping@.service' },
              label: 'Ping units',
              role: 'what sends the pings',
              note: 'One templated unit per slug, wired as an OnSuccess hook by platform/hc-ping. A job that runs fine while its check goes late is this unit failing rather than the job — the ping is a separate exit from the work.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}
