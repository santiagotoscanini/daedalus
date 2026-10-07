import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import {
  compareOf,
  Open,
  ServiceHead,
  SOURCE_NOTE,
  verdictOf,
} from '../../../components/service-head'
import {
  CELL_QUIET,
  TABLE,
  TABLE_EMPTY,
  TABLE_HEAD,
  TABLE_ROW_DENSE,
} from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { CAPTION, FOOT, MONO } from '../../../components/tokens'
import { BoardGrid, Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { DASH, num, since, until } from '../../../lib/format'
import type { MonitoringData } from '../data'

// The Jobs tab: healthchecks joined to the fleet.monitoredJobs registry — every
// scheduled job, whether anything would notice it stopping, and the armed
// switches that never fired.

type Jobs = Extract<MonitoringData, { tab: 'jobs' }>

export function JobsView({ data: d }: { data: Jobs }) {
  const f = jobsFacts({ data: d })

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
            the failure a scheduled job has: a timer that was disabled, never fired, or whose
            service was renamed.
          </>
        }
        // `hc`, not `healthchecks` — see the note on Gatus in probes.tsx.
        actions={<Open name="Healthchecks" host="hc" />}
      />

      <BoardGrid>
        <ScheduledJobsBoard f={f} />

        <DeadManSSwitchesBoard f={f} />

        <ArmedButNeverFiredBoard f={f} />

        <Changelog
          gap={d.gap}
          span={12}
          foot={
            <p className={FOOT}>
              Its releases are numbered with two segments — <span className={MONO}>v4.2</span>, not{' '}
              <span className={MONO}>v4.2.0</span> — so this panel matches them with its own
              pattern; the shared three-segment one would report a project with sixty releases as
              having none. A tag ahead of the newest RELEASE is normal here and is why the verdict
              can read &ldquo;current&rdquo; against an empty list: the image is built from the git
              tag, and the release note follows it by a few days.
            </p>
          }
        />

        <HealthchecksLogsBoard />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function jobsFacts({ data: d }: { data: Jobs }) {
  return { d }
}

type JobsFacts = NonNullable<ReturnType<typeof jobsFacts>>

/** Job · watched by · last run · ran · next. The two times step away first. */
const JOB_GRID =
  'grid items-center gap-x-6 px-5 grid-cols-[minmax(12rem,1.6fr)_8rem_minmax(6rem,0.8fr)_6.5rem_6.5rem] @max-[44rem]/table:grid-cols-[minmax(10rem,1fr)_7.5rem_minmax(6rem,0.8fr)] @max-[44rem]/table:[&>.when]:hidden'

/** A quiet word in a cell: the norm, said without ink. */
const QUIET = 'text-[0.78rem] text-muted-foreground'

function ScheduledJobsBoard({ f }: { f: JobsFacts }) {
  const { d } = f
  const failing = d.jobs.filter(
    (j) => (j.result !== null && j.result !== 'success') || (j.slug !== null && j.status !== 'up'),
  ).length
  return (
    <TableSection
      title="Scheduled jobs"
      aside={`${num(d.jobs.length)} declared · ${num(d.emailOnly)} by mail only${failing > 0 ? ` · ${num(failing)} need a look` : ''}`}
    >
      <ul className={TABLE} aria-label="Scheduled jobs">
        <li className={cn(JOB_GRID, TABLE_HEAD)}>
          <span>Job</span>
          <span>Watched by</span>
          <span>Last run</span>
          <span className="when text-right">Ran</span>
          <span className="when text-right">Next</span>
        </li>
        {d.jobs.length === 0 && <li className={TABLE_EMPTY}>no job declared</li>}
        {d.jobs.map((j) => (
          <li key={j.unit} className={cn(JOB_GRID, TABLE_ROW_DENSE)}>
            <span className="truncate font-mono text-[0.76rem] text-foreground" title={j.unit}>
              {j.unit}
            </span>
            {/* Both ways of being watched are normal and recede; a switch
                that is late, down or unknown is the ink. */}
            <span>
              {j.slug === null ? (
                <span className={QUIET}>mail on failure</span>
              ) : j.status === null ? (
                <Chip tone="bad">slug unknown</Chip>
              ) : j.status === 'up' ? (
                <span className={QUIET}>pinging</span>
              ) : j.status === 'grace' ? (
                <Chip tone="warn">late</Chip>
              ) : (
                <Chip tone="bad">{j.status}</Chip>
              )}
            </span>
            {/* The outcome: what the last run DID. A dash is a job with no
                timer — boot oneshots and path units — whose absence from
                the timer table is information, not a gap. */}
            <span>
              {j.result === null ? (
                <span className={cn(QUIET, 'text-muted-foreground/60')}>{DASH}</span>
              ) : j.result === 'success' ? (
                <span className={QUIET}>success</span>
              ) : (
                <Chip tone="bad">
                  {j.exitStatus === null || j.exitStatus === 0
                    ? j.result
                    : `${j.result} (${String(j.exitStatus)})`}
                </Chip>
              )}
            </span>
            <span className={cn(CELL_QUIET, 'when text-right')}>
              {j.lastRunAgo === null ? DASH : since(j.lastRunAgo)}
            </span>
            <span className={cn(CELL_QUIET, 'when text-right')}>
              {j.nextIn === null ? DASH : until(j.nextIn)}
            </span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        The registry from <span className={MONO}>fleet.monitoredJobs</span>, joined to what
        healthchecks knows. The two are different guarantees: <b>mail on failure</b> means a run
        that fails tells you, and <b>pinging</b> means a run that stops happening at all tells you.
        Only the second catches a timer that was disabled, never fired, or whose service was
        renamed. Mail-only is deliberate for a job that runs on every rebuild, where &ldquo;it did
        not run&rdquo; is not a fault. The outcome column is the host&rsquo;s own timer table via
        the system snapshot: when the last run happened, how it ended, and when the next is due. A
        dash is a job with no timer (boot and rebuild oneshots), not a job that failed to schedule.
      </p>
      <p className={CAPTION}>
        {num(d.emailOnly)} of the {num(d.jobs.length)} here are mail-only. {num(d.unwatchedTimers)}{' '}
        more timers run on the box with no entry in this registry at all.
      </p>
    </TableSection>
  )
}

/** Check · state · due. */
const CHECK_GRID = 'grid items-center gap-x-6 px-5 grid-cols-[minmax(8rem,1fr)_6rem_7rem]'

function DeadManSSwitchesBoard({ f }: { f: JobsFacts }) {
  const { d } = f
  return (
    <TableSection
      title="Dead-man's switches"
      className="col-span-6 max-[78rem]:col-span-12"
      aside={
        d.summary === null
          ? undefined
          : `${num(d.summary.up)} up · ${num(d.summary.late)} late · ${num(d.summary.down)} down`
      }
    >
      <ul className={TABLE} aria-label="Dead-man's switches">
        <li className={cn(CHECK_GRID, TABLE_HEAD)}>
          <span>Check</span>
          <span>State</span>
          <span className="text-right">Due</span>
        </li>
        {d.checks.length === 0 && <li className={TABLE_EMPTY}>healthchecks did not answer</li>}
        {d.checks.map((c) => (
          <li key={c.name} className={cn(CHECK_GRID, TABLE_ROW_DENSE)}>
            <span className="truncate text-foreground">{c.name}</span>
            <span>
              {c.status === 'up' ? (
                <span className={QUIET}>up</span>
              ) : c.status === 'grace' ? (
                <Chip tone="warn">late</Chip>
              ) : (
                <Chip tone="bad">{c.status}</Chip>
              )}
            </span>
            <span
              className={cn(
                CELL_QUIET,
                'text-right',
                c.dueIn !== null && c.dueIn < 0 && 'text-danger',
              )}
            >
              {c.dueIn === null ? DASH : c.dueIn < 0 ? 'overdue' : until(c.dueIn)}
            </span>
          </li>
        ))}
      </ul>
      <p className={FOOT}>
        Each job pings on success; healthchecks alerts when a ping does not arrive inside the period
        plus its grace. <b>Late</b> is the state worth seeing: inside the grace window, not yet an
        alert.
      </p>
    </TableSection>
  )
}

function ArmedButNeverFiredBoard({ f }: { f: JobsFacts }) {
  const { d } = f
  return (
    d.orphaned.length > 0 && (
      // The join's whole reason for existing. Neither system can find this
      // on its own: nix believes the job is watched, healthchecks has never
      // heard of it, and nothing compares the two.
      <TableSection
        title="Armed but never fired"
        className="col-span-6 max-[78rem]:col-span-12"
        aside={`${num(d.orphaned.length)} with no check`}
      >
        <ul className={TABLE} aria-label="Armed but never fired">
          {d.orphaned.map((u) => (
            <li key={u} className={cn(TABLE_ROW_DENSE, 'flex items-center gap-3 px-5')}>
              <span className="min-w-0 flex-auto truncate font-mono text-[0.76rem] text-foreground">
                {u}
              </span>
              <Chip tone="bad">no check</Chip>
            </li>
          ))}
        </ul>
        <p className={FOOT}>
          These declare a healthchecks slug that healthchecks does not have a check for, so the
          dead-man&rsquo;s switch reads as armed in nix and does not exist. A check is created by
          its first ping, which means either the job has never once succeeded, or the ping is
          failing silently. Neither system can see this alone: nix knows the intent, healthchecks
          knows the reality, and this is the only place they are compared.
        </p>
      </TableSection>
    )
  )
}

function HealthchecksLogsBoard() {
  return (
    <LogBoard
      source={{ container: 'healthchecks' }}
      title="Healthchecks logs"
      neighbours={[
        {
          source: { unit: 'hc-ping@.service' },
          label: 'Ping units',
          role: 'what sends the pings',
          note: 'One templated unit per slug, wired as an OnSuccess hook by platform/hc-ping. A job that runs fine while its check goes late is this unit failing rather than the job. The ping is a separate exit from the work.',
        },
      ]}
    />
  )
}
