import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import {
  compareOf,
  Open,
  ServiceHead,
  SOURCE_NOTE,
  verdictOf,
} from '../../../components/service-head'
import { EMPTY, FOOT, MONO, NOTE } from '../../../components/tokens'
import { Board, BoardGrid, Chip } from '../../../components/viz'
import { DASH, num, since, until } from '../../../lib/format'
import type { MonitoringData } from '../data'
import { LIST, MAIN, SIDE } from './shared'

// The Jobs tab: healthchecks joined to the fleet.monitoredJobs registry — every
// scheduled job, whether anything would notice it stopping, and the armed
// switches that never fired.

type Jobs = Extract<MonitoringData, { tab: 'jobs' }>

export function JobsView({ data: d }: { data: Jobs }) {
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
        <Board
          title="Scheduled jobs"
          icon="⏲"
          span={8}
          aside={
            <span className={NOTE}>
              {num(d.jobs.length)} declared · {num(d.emailOnly)} by mail only
            </span>
          }
        >
          <ul className={LIST}>
            {d.jobs.map((j) => (
              <li key={j.unit}>
                <span className={`${MAIN} ${MONO}`}>{j.unit}</span>
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
                {/* The outcome: what the last run DID. A dash is a job with no
                    timer — boot oneshots and path units — whose absence from
                    the timer table is information, not a gap. */}
                {j.result === null ? (
                  <span className={SIDE}>{DASH}</span>
                ) : j.result === 'success' ? (
                  <Chip tone="ok">success</Chip>
                ) : (
                  <Chip tone="bad">
                    {j.exitStatus === null || j.exitStatus === 0
                      ? j.result
                      : `${j.result} (${String(j.exitStatus)})`}
                  </Chip>
                )}
                <span className={SIDE}>
                  {j.lastRunAgo === null ? DASH : `ran ${since(j.lastRunAgo)}`}
                  {' · '}
                  {j.nextIn === null ? DASH : `next ${until(j.nextIn)}`}
                </span>
              </li>
            ))}
          </ul>
          <p className={FOOT}>
            The registry from <span className={MONO}>fleet.monitoredJobs</span>, joined to what
            healthchecks knows. The two are different guarantees: <b>mail on failure</b> means a run
            that fails tells you, and <b>pinging</b> means a run that stops happening at all tells
            you. Only the second catches a timer that was disabled, never fired, or whose service
            was renamed. {num(d.emailOnly)} of the {num(d.jobs.length)} here are mail-only,
            deliberately: for a job that runs on every rebuild, &ldquo;it did not run&rdquo; is not
            a fault. The outcome column is the host&rsquo;s own timer table via the system snapshot:
            when the last run happened, how it ended, and when the next is due. A dash is a job with
            no timer (boot and rebuild oneshots), not a job that failed to schedule.{' '}
            {num(d.unwatchedTimers)} more timers run on the box with no entry in this registry at
            all.
          </p>
        </Board>

        <Board
          title="Dead-man's switches"
          icon="clock"
          span={4}
          aside={
            d.summary === null ? undefined : (
              <span className={NOTE}>
                {num(d.summary.up)} up · {num(d.summary.late)} late · {num(d.summary.down)} down
              </span>
            )
          }
        >
          {d.checks.length === 0 ? (
            <p className={EMPTY}>healthchecks did not answer</p>
          ) : (
            <ul className={LIST}>
              {d.checks.map((c) => (
                <li key={c.name}>
                  <span className={MAIN}>{c.name}</span>
                  <span className={SIDE}>
                    {c.status === 'up' ? (
                      <Chip tone="ok">up</Chip>
                    ) : c.status === 'grace' ? (
                      <Chip tone="warn">late</Chip>
                    ) : (
                      <Chip tone="bad">{c.status}</Chip>
                    )}
                  </span>
                  <span className={SIDE}>
                    {c.dueIn === null ? DASH : c.dueIn < 0 ? 'overdue' : `due ${until(c.dueIn)}`}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className={FOOT}>
            Each job pings on success; healthchecks alerts when a ping does not arrive inside the
            period plus its grace. <b>Late</b> is the state worth seeing: inside the grace window,
            not yet an alert.
          </p>
        </Board>

        {d.orphaned.length > 0 && (
          // The join's whole reason for existing. Neither system can find this
          // on its own: nix believes the job is watched, healthchecks has never
          // heard of it, and nothing compares the two.
          <Board title="Armed but never fired" icon="warn" span={12}>
            <ul className={LIST}>
              {d.orphaned.map((u) => (
                <li key={u}>
                  <Chip tone="bad">no check</Chip>
                  <span className={`${MAIN} ${MONO}`}>{u}</span>
                </li>
              ))}
            </ul>
            <p className={FOOT}>
              These declare a healthchecks slug that healthchecks does not have a check for, so the
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
      </BoardGrid>
    </>
  )
}
