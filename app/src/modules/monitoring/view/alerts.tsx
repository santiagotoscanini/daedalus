import { useState } from 'react'
import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import {
  CELL_QUIET,
  TABLE,
  TABLE_HEAD,
  TABLE_ROW_DENSE,
  TableMore,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { FOOT, MONO, NOTE } from '../../../components/tokens'
import { Board, BoardGrid, Chip, Facts } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, num, since } from '../../../lib/format'
import { Pairs } from '../../network/view/shared'
import type { MonitoringData } from '../data'
import { AllClear, LIST, MAIN, SEVERITY, SIDE } from './shared'

// The Alerts tab: Grafana — what is firing, where a firing alert goes, what is
// muted on purpose, and whether the mail relay at the end of every path works.

type Alerts = Extract<MonitoringData, { tab: 'alerts' }>

export function AlertsView({ data: d }: { data: Alerts }) {
  const f = alertsFacts({ data: d })

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
            Every alert rule here is Grafana-managed and provisioned from files. Its own state
            (users, alert history) lives in the <span className={MONO}>grafana</span> database,
            outside the rebuild trail.
          </>
        }
        actions={<Open name="Grafana" host="grafana" />}
      />

      <BoardGrid>
        <Panel f={f} />

        <WhereAnAlertGoesBoard f={f} />

        <DeliberatelySilentNote />

        <Panel2 f={f} />

        <Changelog gap={d.gap} span={12} />

        <GrafanaLogsBoard />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function alertsFacts({ data: d }: { data: Alerts }) {
  // The rules, by provisioning folder, as one phrase ("34 rules · System 34"):
  // a bar list of one folder was a board of dead space.
  const ruleLine = [
    `${num(d.rules)} rules`,
    ...d.byFolder.map((x) => `${x.label} ${num(x.value)}`),
  ].join(' · ')
  // Present tense only when it is true in the present: a failure NEWER than
  // the newest success means the relay may be broken right now; failures the
  // relay has since recovered from are history, worth listing but not a
  // headline. Failures arrive newest first.
  const newestFailure = d.mail.failures[0]
  const mailFailing =
    newestFailure !== undefined &&
    (d.mail.lastSend === null || newestFailure.agoSeconds < d.mail.lastSend.agoSeconds)
  return { d, newestFailure, mailFailing, ruleLine }
}

type AlertsFacts = NonNullable<ReturnType<typeof alertsFacts>>

function Panel({ f }: { f: AlertsFacts }) {
  const { d, ruleLine } = f
  if (d.active.length === 0) {
    return (
      <AllClear
        title="Nothing firing"
        detail={`No rule is firing or pending. All ${num(d.rules)} are evaluating and quiet.`}
        aside={ruleLine}
        note="Grafana's rules, provisioned from files in assets/provisioning/alerting/ (one folder per file; UI edits do not survive). Prometheus's own /rules endpoint is empty and would report zero."
      />
    )
  }
  return (
    <Board title="Firing now" icon="⚑" span={12} aside={<span className={NOTE}>{ruleLine}</span>}>
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
      <p className={FOOT}>
        These are Grafana&rsquo;s rules, not prometheus&rsquo;s. Prometheus&rsquo;s own{' '}
        <span className={MONO}>/rules</span> endpoint is empty and would report zero on a box with{' '}
        {num(d.rules)}. Severity is a label on the generated alert instance rather than on the rule,
        which is why only active ones carry it.
      </p>
    </Board>
  )
}

function WhereAnAlertGoesBoard({ f }: { f: AlertsFacts }) {
  const { d } = f
  return (
    <Board title="Where an alert goes" icon="✉" span={12}>
      <Pairs
        rows={[
          { k: 'Contact points', v: num(d.delivery.contactPoints) },
          { k: 'Email', v: 'msmtp relay' },
          { k: 'Grafana', v: d.grafana.version ?? DASH },
          { k: 'Dashboards', v: num(d.grafana.dashboards) },
        ]}
      />
      <p className={FOOT}>
        A firing rule reaches a person by email through the same relay smartd and every{' '}
        <span className={MONO}>OnFailure</span> unit use. There is no phone alert on this box. The
        escalation path is a mailbox.
      </p>
    </Board>
  )
}

function Panel2({ f }: { f: AlertsFacts }) {
  const { d, mailFailing } = f
  return (
    <>
      <Board
        title={mailFailing ? 'Mail relay failing' : 'The mail relay'}
        icon="✉"
        span={12}
        aside={
          d.mail.failures.length === 0 ? (
            <span className={NOTE}>
              {d.mail.sent30d === null ? DASH : num(d.mail.sent30d)} sent in 30 days
            </span>
          ) : mailFailing ? (
            <Chip tone="bad">
              {num(d.mail.failed30d)} failed send{d.mail.failed30d === 1 ? '' : 's'} in 30 days
            </Chip>
          ) : (
            // Recovered since: history, not attention — neutral text.
            <span className={NOTE}>
              {num(d.mail.failed30d)} failed send{d.mail.failed30d === 1 ? '' : 's'} in 30 days
            </span>
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
                d.mail.lastSend === null ? (
                  'nothing in the last 30 days'
                ) : (
                  <>
                    {since(d.mail.lastSend.agoSeconds)}
                    <span className="block text-[0.78rem] text-muted-foreground [font-weight:400] [overflow-wrap:anywhere]">
                      from {d.mail.lastSend.unit}
                    </span>
                  </>
                ),
            },
            {
              k: 'Failures, 30d',
              v:
                d.mail.failed30d === null
                  ? DASH
                  : d.mail.failed30d > 0
                    ? // Plain: the header chip already says it in amber, once.
                      num(d.mail.failed30d)
                    : 'none',
            },
          ]}
        />
        <p className={FOOT}>
          Read back from what the relay logged: msmtp writes one journal line per delivery attempt,
          filed under the unit that was sending, so this is every mail the box tried to send
          (smartd, ZED, each <span className={MONO}>OnFailure</span> hook), not just
          Grafana&rsquo;s. This path has no watcher of its own: a dead Gmail app password makes the
          box <b>quieter</b>, not louder, because the failure notice would have to travel the path
          that just broke. A long gap since the last send is normal, since alerts are rare, but a
          red row here means something tried to reach you and could not. Known hole either way: the
          box resolves DNS through its own pi-hole, so a pi-hole-down alert can never email out.
        </p>
      </Board>

      <FailedSendsTable f={f} />
    </>
  )
}

function GrafanaLogsBoard() {
  return (
    <LogBoard
      source={{ container: 'grafana' }}
      title="Grafana logs"
      foot={
        <p className={FOOT}>
          Rule evaluation, provisioning and notification delivery all land here. An alert that
          should have arrived and did not is either a contact point erroring in this log or a rule
          that never left the pending state.
        </p>
      }
    />
  )
}

/** How many units the failed-sends table shows before the rest fold. */
const SEND_CAP = 5

/** Unit · error · when. The error steps away first. */
const SEND_GRID =
  'grid items-start gap-x-6 px-5 grid-cols-[minmax(0,1fr)_minmax(0,1fr)_6rem] @max-[40rem]/table:grid-cols-[minmax(0,1fr)_auto] @max-[40rem]/table:gap-x-3 @max-[40rem]/table:[&>.err]:hidden'

/**
 * Every send the relay logged as failed, newest first. Every row here is a
 * fault, so the table needs no per-row badge: its title says it once.
 */
function FailedSendsTable({ f }: { f: AlertsFacts }) {
  const { d, mailFailing } = f
  const [all, setAll] = useState(false)
  if (d.mail.failures.length === 0) return null
  // One row per sending unit: the same unit failing twelve times is one fact
  // ("x12, last 7h ago"), not twelve rows. Newest first, as the log arrives.
  const byUnit = new Map<string, { latest: (typeof d.mail.failures)[number]; n: number }>()
  for (const x of d.mail.failures) {
    const g = byUnit.get(x.unit)
    if (g === undefined) byUnit.set(x.unit, { latest: x, n: 1 })
    else g.n += 1
  }
  const groups = [...byUnit.values()]
  const shown = all ? groups : groups.slice(0, SEND_CAP)
  return (
    <TableSection
      title="Failed sends"
      aside={mailFailing ? 'newer than the last success' : 'since recovered'}
    >
      <ul className={TABLE} aria-label="Failed mail sends">
        <li className={cn(SEND_GRID, TABLE_HEAD)}>
          <span>Sending unit</span>
          <span className="err">Error</span>
          <span className="text-right">When</span>
        </li>
        {shown.map(({ latest: x, n }) => (
          <li key={x.unit} className={cn(SEND_GRID, TABLE_ROW_DENSE)}>
            <span className="flex min-w-0 flex-col py-1">
              <span className="font-mono text-[0.76rem] text-foreground [overflow-wrap:anywhere]">
                {x.unit}
                {n > 1 && (
                  <span className="ml-2 font-sans text-[0.75rem] text-muted-foreground">×{n}</span>
                )}
              </span>
              {/* On a phone the error is this line, wrapping rather than cut. */}
              <span
                className={cn(
                  'hidden text-[0.75rem] text-muted-foreground @max-[40rem]/table:block',
                  mailFailing && 'text-danger/90',
                )}
              >
                {x.error}
              </span>
            </span>
            <span
              className={cn(
                CELL_QUIET,
                'err py-1 [overflow-wrap:anywhere]',
                mailFailing && 'text-danger/90',
              )}
            >
              {x.error}
            </span>
            <span className={cn(CELL_QUIET, 'py-1 text-right')}>{since(x.agoSeconds)}</span>
          </li>
        ))}
        {groups.length > SEND_CAP && (
          <TableMore
            open={all}
            onToggle={() => {
              setAll((v) => !v)
            }}
            more={`${String(groups.length - SEND_CAP)} more units`}
            less={`Show the first ${String(SEND_CAP)}`}
          />
        )}
      </ul>
    </TableSection>
  )
}

/**
 * The muted Home Assistant paths, as an inline note rather than a card: it is
 * a standing fact about what this page will never show, not a reading.
 */
function DeliberatelySilentNote() {
  return (
    // Not a fault, and the page has to say so — a muted alert path and an
    // alert path that was never built look identical from here.
    <p className="col-span-12 m-0 max-w-[40rem] text-[0.8rem] leading-[1.55] text-muted-foreground">
      <span className="text-subdued [font-weight:560]">Deliberately silent.</span> Every Home
      Assistant alert path on this box is switched off on purpose, indefinitely. Nothing here will
      mention Home Assistant while that holds, and a quiet page is not evidence that it is well.
      <span className="mt-1 block text-[0.78rem]">
        The one that used to fire was the television being turned off, so{' '}
        <span className={MONO}>media_player</span> and <span className={MONO}>remote</span> are
        excluded. The 25 Tuya lights sitting unavailable are genuinely not healthy, which is why the
        entity-count rule could not be re-armed with a higher threshold. Grep{' '}
        <span className={MONO}>HA-MUTED</span> in the configuration checkout to find every switch.
      </span>
    </p>
  )
}
