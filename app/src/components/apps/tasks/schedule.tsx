import { cn } from '../../../lib/cn'
import {
  describeSchedule,
  expandSchedule,
  type SchedulePreset,
  taskScheduleError,
} from '../../../lib/tasks'
import { Segmented } from '../../controls'
import { INPUT_FORM } from '../../tokens'
import { Field, FieldDescription, FieldError, FieldLabel } from '../../ui/field'
import { Input } from '../../ui/input'

// The editor's schedule: two presets that expand to this app's own minute,
// or a calendar written by hand, and always the expansion beside its reading.

/** The two presets, plus the escape hatch for a calendar written by hand. */
export type ScheduleMode = SchedulePreset | 'custom'

/** Which preset produced this calendar string, or neither. */
export function scheduleModeOf(schedule: string, app: string): ScheduleMode {
  if (schedule === expandSchedule('hourly', app)) return 'hourly'
  if (schedule === expandSchedule('daily', app)) return 'daily'
  return 'custom'
}

/** The OnCalendar string a mode and a hand-written calendar make. */
export function scheduleOf(mode: ScheduleMode, custom: string, app: string): string {
  return mode === 'custom' ? custom.trim() : expandSchedule(mode, app)
}

export function ScheduleField({
  app,
  mode,
  onMode,
  custom,
  onCustom,
}: {
  app: string
  mode: ScheduleMode
  onMode: (m: ScheduleMode) => void
  custom: string
  onCustom: (v: string) => void
}) {
  const schedule = scheduleOf(mode, custom, app)
  const scheduleErr = taskScheduleError(schedule)
  return (
    <Field className="gap-[0.35rem] py-2">
      <FieldLabel className="text-[0.76rem] font-normal text-muted-foreground">Schedule</FieldLabel>
      <div>
        <Segmented
          value={mode}
          label="Schedule"
          onChange={(v: ScheduleMode) => {
            onMode(v)
          }}
          options={[
            { value: 'hourly', label: 'Hourly', icon: '↻' },
            { value: 'daily', label: 'Daily', icon: '☾' },
            { value: 'custom', label: 'Custom', icon: '✎' },
          ]}
        />
      </div>
      {mode === 'custom' && (
        <Input
          type="text"
          className={cn(INPUT_FORM, 'mt-[0.35rem] font-mono')}
          value={custom}
          placeholder="Mon *-*-* 03:17:00"
          aria-invalid={scheduleErr !== null && custom !== ''}
          onChange={(e) => {
            onCustom(e.target.value)
          }}
        />
      )}
      {/* The expansion, always, and beside the sentence: the string is what
          systemd is given and the sentence is this app's reading of it. A
          preset that did not show its minute would be a schedule chosen
          blind — and the minute is the whole reason the presets exist. */}
      {scheduleErr !== null && !(mode === 'custom' && custom === '') ? (
        <FieldError className="text-[0.76rem] leading-[1.45]">{scheduleErr}</FieldError>
      ) : (
        <p className="mt-[0.15rem] mr-0 mb-0 ml-0 flex flex-wrap items-baseline gap-x-[0.7rem] text-[0.8rem]">
          <span>{schedule === '' ? 'No schedule yet' : describeSchedule(schedule)}</span>
          <code className="text-[0.78rem] text-muted-foreground">{schedule}</code>
        </p>
      )}
      {mode !== 'custom' && (
        <FieldDescription className="text-[0.76rem] leading-[1.45]">
          The minute is derived from this app’s name, so it is stable across edits and never :00 —
          that is when myspeed’s speedtest takes house-wide DNS down for a couple of minutes.
        </FieldDescription>
      )}
    </Field>
  )
}
