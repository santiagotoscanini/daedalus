import { useId, useState } from 'react'
import { cn } from '../../../lib/cn'

import {
  DEFAULT_TASK_TIMEOUT_SEC,
  taskCommandError,
  taskIdError,
  taskScheduleError,
  taskTimeoutError,
} from '../../../lib/tasks'
import { INPUT_FORM } from '../../tokens'
import { Button } from '../../ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'
import { GHOST_BTN } from '../shared'
import { ScheduleField, type ScheduleMode, scheduleModeOf, scheduleOf } from './schedule'
import type { TaskDraft } from './types'

/**
 * One argv element, with a key of its own.
 *
 * Keyed by a counter rather than by index: the boxes are added and removed
 * while being typed in, and React reuses a DOM node whose key did not change —
 * with index keys, deleting argument 2 moves 3's text into 2's box while the
 * cursor is in it.
 */
type Arg = { key: number; value: string }

/**
 * Add or edit one task.
 *
 * Three decisions here are the feature rather than the form:
 *
 * The presets expand to a CONCRETE OnCalendar before anything is saved
 * (lib/tasks.ts), and the expansion is shown — so the operator reads the exact
 * minute the timer will elapse, on this app's own stable minute, which is
 * never :00. Writing `hourly` through would be accepted by systemd and would
 * fire in myspeed's DNS blackout; the boundary refuses it, and so does nix.
 *
 * The command is argv, entered one argument per box. A single free-text line
 * split on spaces cannot express `["echo", "a b"]`, and the failure is silent:
 * the task runs, with two arguments where one was meant.
 *
 * Every rule shows its sentence as you type, from the same functions the
 * server boundary enforces — so a refusal is visible before the save rather
 * than returned by it.
 */
export function TaskEditor({
  app,
  taken,
  initial,
  busy,
  onSubmit,
  onCancel,
}: {
  app: string
  /** The OTHER tasks' ids — what this one may not be called. */
  taken: string[]
  initial?: TaskDraft
  busy: boolean
  onSubmit: (task: TaskDraft) => void
  onCancel: () => void
}) {
  const idField = useId()
  const timeoutField = useId()

  const [id, setId] = useState(initial?.id ?? '')
  const [mode, setMode] = useState<ScheduleMode>(
    initial ? scheduleModeOf(initial.schedule, app) : 'daily',
  )
  const [custom, setCustom] = useState(
    initial && scheduleModeOf(initial.schedule, app) === 'custom' ? initial.schedule : '',
  )
  const [args, setArgs] = useState<Arg[]>(() =>
    (initial?.command ?? ['']).map((value, i) => ({ key: i, value })),
  )
  const [nextKey, setNextKey] = useState(() => (initial?.command.length ?? 1) + 1)
  const [timeoutText, setTimeoutText] = useState(
    String(initial?.timeoutSec ?? DEFAULT_TASK_TIMEOUT_SEC),
  )

  const schedule = scheduleOf(mode, custom, app)
  const command = args.map((a) => a.value)
  const timeoutSec = Number(timeoutText)

  const idErr = taskIdError(id, taken)
  const scheduleErr = taskScheduleError(schedule)
  const commandErr = taskCommandError(command)
  const timeoutErr = Number.isNaN(timeoutSec)
    ? 'must be a number of seconds.'
    : taskTimeoutError(timeoutSec)
  const ok = idErr === null && scheduleErr === null && commandErr === null && timeoutErr === null

  // Errors are shown once a field has been WRITTEN in, never on an untouched
  // one: a form that opens with two red lines reads as broken rather than
  // empty. Saving is disabled by `ok` either way, so nothing is hidden that
  // would let a bad task through.
  const commandTouched = args.length > 1 || command.some((a) => a !== '')

  return (
    <li className="rounded-lg border border-primary/40 bg-card px-[1.05rem] py-[0.95rem]">
      <div className="grid grid-cols-2 gap-x-[1.2rem] gap-y-[0.2rem] max-[46rem]:grid-cols-1">
        <Field className="gap-[0.3rem] py-2">
          <FieldLabel
            htmlFor={idField}
            className="text-[0.76rem] font-normal text-muted-foreground"
          >
            Id
          </FieldLabel>
          <Input
            id={idField}
            type="text"
            className={INPUT_FORM}
            value={id}
            placeholder="digest"
            // An existing task's id is the unit name the box already knows, and
            // renaming it is a delete plus a create rather than an edit — so it
            // is set once, at creation, and read-only afterwards.
            disabled={initial !== undefined}
            aria-invalid={idErr !== null && id !== ''}
            onChange={(e) => {
              setId(e.target.value)
            }}
          />
          {idErr !== null && id !== '' ? (
            <FieldError className="text-[0.76rem] leading-[1.45]">{idErr}</FieldError>
          ) : (
            <FieldDescription className="text-[0.76rem] leading-[1.45]">
              {initial === undefined ? (
                <>
                  Becomes{' '}
                  <code>
                    app-{app}-task-{id || '<id>'}
                  </code>
                  , and cannot be changed afterwards.
                </>
              ) : (
                <>
                  Fixed: this is the unit name{' '}
                  <code>
                    app-{app}-task-{id}
                  </code>
                  . Remove and re-add to rename.
                </>
              )}
            </FieldDescription>
          )}
        </Field>

        <Field className="gap-[0.3rem] py-2">
          <FieldLabel
            htmlFor={timeoutField}
            className="text-[0.76rem] font-normal text-muted-foreground"
          >
            Timeout
          </FieldLabel>
          <Input
            id={timeoutField}
            type="number"
            min={1}
            step={1}
            className={INPUT_FORM}
            value={timeoutText}
            aria-invalid={timeoutErr !== null}
            onChange={(e) => {
              setTimeoutText(e.target.value)
            }}
          />
          {timeoutErr !== null ? (
            <FieldError className="text-[0.76rem] leading-[1.45]">{timeoutErr}</FieldError>
          ) : (
            <FieldDescription className="text-[0.76rem] leading-[1.45]">
              Seconds. <code>TimeoutStartSec</code> on the generated unit: a run still going at{' '}
              {timeoutText}s is killed and mailed as a failure.
            </FieldDescription>
          )}
        </Field>
      </div>

      <ScheduleField app={app} mode={mode} onMode={setMode} custom={custom} onCustom={setCustom} />

      <Field className="gap-[0.35rem] py-2">
        <FieldLabel className="text-[0.76rem] font-normal text-muted-foreground">
          Command (argv)
        </FieldLabel>
        <ol className="m-0 flex list-none flex-col gap-[0.35rem] p-0">
          {args.map((a, i) => (
            <li key={a.key} className="flex items-center gap-[0.5rem]">
              <span className="w-[1.1rem] shrink-0 text-right text-[0.72rem] text-muted-foreground">
                {i + 1}
              </span>
              <Input
                type="text"
                aria-label={`argument ${String(i + 1)}`}
                className={cn(INPUT_FORM, 'font-mono')}
                value={a.value}
                placeholder={i === 0 ? 'node' : 'scripts/digest.mjs'}
                onChange={(e) => {
                  const { value } = e.target
                  setArgs((prev) => prev.map((p) => (p.key === a.key ? { ...p, value } : p)))
                }}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn(GHOST_BTN, 'shrink-0')}
                aria-label={`remove argument ${String(i + 1)}`}
                disabled={args.length === 1}
                onClick={() => {
                  setArgs((prev) => prev.filter((p) => p.key !== a.key))
                }}
              >
                ✕
              </Button>
            </li>
          ))}
        </ol>
        <div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className={cn(GHOST_BTN, 'mt-[0.15rem]')}
            onClick={() => {
              setArgs((prev) => [...prev, { key: nextKey, value: '' }])
              setNextKey((k) => k + 1)
            }}
          >
            + Argument
          </Button>
        </div>
        {commandErr !== null && commandTouched ? (
          <FieldError className="text-[0.76rem] leading-[1.45]">{commandErr}</FieldError>
        ) : (
          <FieldDescription className="text-[0.76rem] leading-[1.45]">
            One argument per box, passed through exactly as typed — no shell, so nothing is split on
            spaces and nothing in an argument is interpreted. Runs as:{' '}
            <code className="[overflow-wrap:anywhere]">
              podman exec app-{app} {command.map((c) => (/\s/.test(c) ? `"${c}"` : c)).join(' ')}
            </code>
          </FieldDescription>
        )}
      </Field>

      <div className="mt-[0.7rem] flex flex-wrap items-center gap-[0.6rem]">
        <Button
          type="button"
          size="sm"
          disabled={!ok || busy}
          onClick={() => {
            onSubmit({ id: id.trim().toLowerCase(), schedule, command, timeoutSec })
          }}
        >
          {busy ? 'Saving…' : initial === undefined ? 'Add task' : 'Save task'}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className={GHOST_BTN}
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
        <span className="text-[0.73rem] text-muted-foreground">
          Saved to the registry; the unit appears on the next Apply.
        </span>
      </div>
    </li>
  )
}
