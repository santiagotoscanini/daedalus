import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { BarList, Board, BoardGrid, Chip, Facts } from '../../../components/viz'
import { DASH, num, since } from '../../../lib/format'
import type { MonitoringData } from '../data'
import { LIST, MAIN, SEVERITY, SIDE } from './shared'

// The Alerts tab: Grafana — what is firing, where a firing alert goes, what is
// muted on purpose, and whether the mail relay at the end of every path works.

type Alerts = Extract<MonitoringData, { tab: 'alerts' }>

export function AlertsView({ data: d }: { data: Alerts }) {
  // Present tense only when it is true in the present: a failure NEWER than
  // the newest success means the relay may be broken right now; failures the
  // relay has since recovered from are history, worth listing but not a
  // headline. Failures arrive newest first.
  const newestFailure = d.mail.failures[0]
  const mailFailing =
    newestFailure !== undefined &&
    (d.mail.lastSend === null || newestFailure.agoSeconds < d.mail.lastSend.agoSeconds)

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
            Every alert rule on this box is Grafana-managed and provisioned from files, so this both
            draws the graphs and decides when one of them is worth an email. Its own state — users,
            service accounts, alert history — lives in the <span className={MONO}>grafana</span>{' '}
            database on the shared cluster, which is the half of it that is not in the rebuild
            trail.
          </>
        }
        actions={<Open name="Grafana" host="grafana" />}
      />

      <BoardGrid>
        <Board
          title={d.active.length === 0 ? 'Nothing firing' : 'Firing now'}
          icon="⚑"
          span={8}
          aside={<span className={NOTE}>{num(d.rules)} rules</span>}
        >
          {d.active.length === 0 ? (
            <p className={EMPTY}>
              No rule is firing or pending. All {num(d.rules)} are evaluating and quiet.
            </p>
          ) : (
            <ul className={LIST}>
              {d.active.map((a) => (
                <li key={`${a.folder}-${a.name}`}>
                  <Chip tone={SEVERITY[a.severity] ?? 'muted'}>{a.severity}</Chip>
                  <span className={MAIN} title={a.summary}>
                    {a.name}
                  </span>
                  <span className={SIDE}>{a.folder}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            These are Grafana&rsquo;s rules, not prometheus&rsquo;s. Prometheus&rsquo;s own{' '}
            <span className={MONO}>/rules</span> endpoint is empty and would report zero on a box
            with {num(d.rules)}. Severity is a label on the generated alert instance rather than on
            the rule, which is why only active ones carry it.
          </p>
        </Board>

        <Board title="Rules by folder" icon="rows" span={4}>
          <BarList items={d.byFolder} tone="info" empty="no rules" />
          <p className={FOOT}>
            Folders are the provisioning files in{' '}
            <span className={MONO}>assets/provisioning/alerting/</span>. UI edits do not survive.
            The files are source of truth.
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
          <p className={FOOT}>
            A firing rule reaches a person by email through the same relay smartd and every{' '}
            <span className={MONO}>OnFailure</span> unit use. There is no phone alert on this box.
            The escalation path is a mailbox.
          </p>
        </Board>

        <Board title="Deliberately silent" icon="🔇" span={8}>
          {/* Not a fault, and the page has to say so — a muted alert path and an
            alert path that was never built look identical from here. */}
          <p className={FOOT}>
            Every Home Assistant alert path on this box is <b>switched off on purpose</b>,
            indefinitely. The one that used to fire was the television being turned off, so{' '}
            <span className={MONO}>media_player</span> and <span className={MONO}>remote</span> are
            excluded. The 25 Tuya lights sitting unavailable in the floor are genuinely not healthy,
            which is why the entity-count rule could not be re-armed with a higher threshold. Grep{' '}
            <span className={MONO}>HA-MUTED</span> in the configuration checkout to find every
            switch. Nothing above will ever mention Home Assistant while that holds, and a quiet
            board is not evidence that it is well.
          </p>
        </Board>

        <Board
          title={mailFailing ? 'Mail relay failing' : 'The mail relay'}
          icon="✉"
          span={12}
          aside={
            d.mail.failures.length === 0 ? (
              <span className={NOTE}>
                {d.mail.sent30d === null ? DASH : num(d.mail.sent30d)} sent in 30 days
              </span>
            ) : (
              <Chip tone={mailFailing ? 'bad' : 'warn'}>
                {num(d.mail.failed30d)} failed send{d.mail.failed30d === 1 ? '' : 's'} in 30 days
              </Chip>
            )
          }
        >
          <Facts
            rows={[
              {
                k: 'Identity',
                v:
                  d.mail.identity === null
                    ? DASH
                    : `${d.mail.identity.sender} → ${d.mail.identity.alertTo}`,
              },
              {
                // Neutral on purpose: alerts are rare on a healthy box, so
                // "nothing sent in N days" is a normal state, not a warning.
                k: 'Last successful send',
                v:
                  d.mail.lastSend === null
                    ? 'nothing in the last 30 days'
                    : `${since(d.mail.lastSend.agoSeconds)} — from ${d.mail.lastSend.unit}`,
              },
              {
                k: 'Failures, 30d',
                v:
                  d.mail.failed30d === null ? (
                    DASH
                  ) : d.mail.failed30d > 0 ? (
                    <span className="text-warning">{num(d.mail.failed30d)}</span>
                  ) : (
                    <Chip tone="ok">none</Chip>
                  ),
              },
            ]}
          />
          {d.mail.failures.length > 0 && (
            <ul className={LIST}>
              {d.mail.failures.map((f) => (
                <li key={`${f.unit}-${String(f.agoSeconds)}`}>
                  <Chip tone="bad">failed</Chip>
                  <span className={`${MAIN} ${MONO}`}>{f.unit}</span>
                  <span className={SIDE}>{f.error}</span>
                  <span className={SIDE}>{since(f.agoSeconds)}</span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            Read back from what the relay logged: msmtp writes one journal line per delivery
            attempt, filed under the unit that was sending, so this is every mail the box tried to
            send (smartd, ZED, each <span className={MONO}>OnFailure</span> hook), not just
            Grafana&rsquo;s. This path has no watcher of its own: a dead Gmail app password makes
            the box <b>quieter</b>, not louder, because the failure notice would have to travel the
            path that just broke. A long gap since the last send is normal, since alerts are rare,
            but a red row here means something tried to reach you and could not. Known hole either
            way: the box resolves DNS through its own pi-hole, so a pi-hole-down alert can never
            email out.
          </p>
        </Board>

        <Changelog gap={d.gap} span={12} />

        <LogBoard
          source={{ container: 'grafana' }}
          title="Grafana logs"
          foot={
            <p className={FOOT}>
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
