import { actorLabel } from '../../core/auth'
import { requestTaskRun } from '../../host/task-run'
import { hostFacts, type JobRun } from '../dashboard/host-facts'
import { getApp } from '../repo/apps'
import { describeSchedule, taskUnitName } from '../tasks'

// The Tasks tab's data layer, and the one verb behind its Run now button.
//
// The seam (server/registry.ts) does no work: it proves the request's shape
// and hands it here, where the reading, the checks and the "why" live — same
// split as ./deploy.ts, and for the same two reasons stated at the top of that
// seam file (`src/server/**` may static-import nothing impure, and an RPC id
// is derived from the file path plus the export name, so the declarations
// cannot move).

/** One task as the tab renders it: what it is, and how its last run ended. */
export type TaskRow = {
  id: string
  /** The raw systemd calendar string, shown as itself next to the sentence. */
  schedule: string
  /** That string in words, or an admission that it was not recognised. */
  scheduleText: string
  command: string[]
  timeoutSec: number
  /** `app-<name>-task-<id>` — the unit pair, and the Loki `unit` label. */
  unit: string
  /**
   * When the timer last elapsed, from the host snapshot's timer table, as an
   * ISO instant. Null means it has not fired since boot — OR that nix has not
   * generated the unit yet, which is the state every task is in until the
   * Apply that ships it.
   */
  lastRunAt: string | null
  nextRunAt: string | null
  /**
   * systemd's verdict on that run, and its exit status. Both null unless
   * there IS a run to describe: systemd reports success/0 on a service that
   * has never started, which would read as a green task that never ran.
   */
  result: string | null
  exitStatus: number | null
}

export type TasksPayload = {
  tasks: TaskRow[]
  /**
   * Whether the app has a container to exec into at all. A `declared` app
   * runs nothing, so nix generates no task units for it and a Run now would
   * fail every time — the tab says so instead of offering the button.
   */
  running: boolean
}

/**
 * The snapshot's epoch seconds as an instant the page can format.
 *
 * 0 is systemd's "never" for both columns, and `list-timers` hands it back as
 * a real timestamp rather than a null — rendered, that is January 1970 in a
 * column about tonight.
 */
const iso = (seconds: number | null | undefined): string | null =>
  seconds === null || seconds === undefined || seconds <= 0
    ? null
    : new Date(seconds * 1000).toISOString()

/**
 * The tab body: the app's declared tasks, each joined to what its timer
 * actually did.
 *
 * The run facts come from the host snapshot (`/system/system.json`, written
 * every 10 minutes by daedalus-system-snapshot) rather than from a query,
 * because `systemctl list-timers` is the only thing that knows them and this
 * container cannot run it. That snapshot's timer table carries last, next,
 * result and exit status — there is no duration column, so the tab does not
 * claim one.
 */
export async function loadTasksTab(name: string): Promise<TasksPayload> {
  const record = await getApp(name)
  if (!record) return { tasks: [], running: false }

  const facts = await hostFacts().catch(() => null)
  // Indexed under the stripped timer AND service names, the same way the
  // monitoring page does it: the snapshot names real units and a task is a
  // pair, so either half should match the one name declared here.
  const runByUnit = new Map<string, JobRun>()
  for (const r of facts?.jobs ?? []) {
    runByUnit.set(r.timer.replace(/\.timer$/, ''), r)
    if (r.service !== null) runByUnit.set(r.service.replace(/\.service$/, ''), r)
  }

  return {
    running: record.stage !== 'declared',
    tasks: record.tasks.map((t) => {
      const unit = taskUnitName(name, t.taskId)
      const run = runByUnit.get(unit)
      const ran = run !== undefined && run.lastAt !== null
      return {
        id: t.taskId,
        schedule: t.schedule,
        scheduleText: describeSchedule(t.schedule),
        command: t.command,
        timeoutSec: t.timeoutSec,
        unit,
        lastRunAt: iso(ran ? run.lastAt : null),
        nextRunAt: iso(run?.nextAt ?? null),
        result: ran ? run.result : null,
        exitStatus: ran ? run.exitStatus : null,
      }
    }),
  }
}

/**
 * Run one task now, by asking the host to start the unit its timer already
 * starts.
 *
 * Both checks here matter and neither is the seam's job. The task must be one
 * this app DECLARES — an id that passes the charset but names no unit would
 * otherwise reach the host as a `systemctl start` of something that does not
 * exist, and the honest answer to that is a sentence, not a failed unit. And
 * the app must be running: a task is `podman exec app-<name> …`, which fails
 * every tick against a `declared` app that has no container.
 */
export async function runAppTaskNow(input: {
  name: string
  task: string
}): Promise<{ id: string }> {
  const record = await getApp(input.name)
  if (!record) throw new Error(`no app named ${input.name}`)

  if (!record.tasks.some((t) => t.taskId === input.task)) {
    throw new Error(`${input.name} declares no task called ${input.task}`)
  }
  if (record.stage === 'declared') {
    throw new Error(
      `${input.name} is declared but not running — a task runs inside its container, and there is none yet`,
    )
  }

  const actor = actorLabel()
  return { id: await requestTaskRun({ app: input.name, task: input.task, actor }) }
}
