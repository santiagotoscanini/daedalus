import { useRouter } from '@tanstack/react-router'
import { type ReactNode, useId, useState, useTransition } from 'react'

import type { SiteEdit, SiteField } from '../../core/site'
import { cn } from '../../lib/cn'
import { getSiteField, parseUpstreams } from '../../lib/site-fields'
import {
  type DiffLine,
  diffCounts,
  diffLines,
  type FoldedLine,
  foldUnchanged,
} from '../../lib/text-diff'
import { saveSiteEditFn } from '../../server/site'
import { Alert, AlertDescription } from '../ui/alert'
import { Field, FieldError } from '../ui/field'
import { Input } from '../ui/input'
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from '../ui/select'
import { Switch } from '../ui/switch'
import { Textarea } from '../ui/textarea'
import { Chip } from '../viz'
import { Mono } from './shared'

// The editable rows of the settings tabs — the fields nix sources from
// site.json, and nothing else.
//
// Each control shows the DESIRED value (what an Apply would write) and saves
// it on blur or Enter, one field per request; the server decodes the whole
// document and refuses a bad type, and that refusal is shown under the box.
// When desired differs from what is committed, the row says so — a `pending`
// chip and the committed value beside it — because until Apply runs nothing
// on the box has changed, and the operator should be able to see what they
// are changing FROM. Setting a field back to its committed value is how an
// edit is undone: the data layer drops the draft when nothing differs.
//
// The controls live inside a `Facts` row's value cell, so the label is the
// row's `dt` and the input carries it as `aria-label`; the `Field` wrapper
// groups the control with its error the way the form rows elsewhere do.

const INPUT = cn(
  'h-auto w-[15rem] max-w-full rounded-[8px] bg-(--panel-2) px-[0.65rem] py-[0.4rem]',
  'font-mono md:text-[0.8rem] dark:bg-(--panel-2)',
)

const ASIDE = 'text-[0.72rem] text-(--dim)'

function useSiteSave() {
  const router = useRouter()
  const [saving, start] = useTransition()
  // Why the server refused — a type the decoder would not take. Distinct from
  // the local validator, which answers before a request is made.
  const [refused, setRefused] = useState<string | null>(null)
  const save = (patch: Partial<Record<SiteField, unknown>>) => {
    setRefused(null)
    start(async () => {
      try {
        await saveSiteEditFn({ data: patch })
        await router.invalidate()
      } catch (e) {
        setRefused(e instanceof Error ? e.message : String(e))
      }
    })
  }
  return { save, saving, refused }
}

function show(v: unknown): string {
  if (v === null || v === undefined || v === '') return 'not set'
  if (Array.isArray(v)) return v.map(String).join(', ')
  if (typeof v === 'boolean') return v ? 'active' : 'off'
  return String(v)
}

/** The `pending` chip and the committed value, when the two differ. */
function Provenance({ edit, field }: { edit: SiteEdit; field: SiteField }) {
  if (edit.committed === null || !edit.changes.includes(field)) return null
  return (
    <>
      <Chip tone="info">pending</Chip>
      <span className={ASIDE}>
        was{' '}
        <Mono className="text-[0.74rem] text-(--dim)">
          {show(getSiteField(edit.committed, field))}
        </Mono>
      </span>
    </>
  )
}

function Control({
  edit,
  field,
  error,
  saving,
  children,
}: {
  edit: SiteEdit
  field: SiteField
  error: string | null
  saving: boolean
  children: ReactNode
}) {
  return (
    <Field invalid={error !== null} className="w-auto items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {saving && <span className={ASIDE}>saving…</span>}
        <Provenance edit={edit} field={field} />
        {children}
      </div>
      {error !== null && (
        <FieldError className="max-w-[24rem] text-right text-[0.74rem] leading-[1.45]">
          {error}
        </FieldError>
      )}
    </Field>
  )
}

type TextProps = {
  edit: SiteEdit
  field: SiteField
  /** The row's label, for the input's accessible name. */
  label: string
  /** Returns an operator-facing reason, or null when the value is usable. */
  validate?: (v: string) => string | null
  /** An empty box saves `null` rather than `""` (interface, gateway). */
  nullable?: boolean
  className?: string
}

/** A string field. Saves on blur or Enter; Escape puts the desired value back. */
export function SiteText(props: TextProps) {
  const value = getSiteField(props.edit.desired, props.field)
  const text = value === null || value === undefined ? '' : String(value)
  // Keyed on the desired value: a save (ours or another row's) or a revert
  // remounts the box with the value the document now holds, and a refused
  // save — value unchanged — keeps what was typed so it can be fixed.
  return <TextInner key={text} {...props} value={text} />
}

function TextInner({
  edit,
  field,
  label,
  validate,
  nullable,
  className,
  value,
}: TextProps & { value: string }) {
  const id = useId()
  const { save, saving, refused } = useSiteSave()
  const [draft, setDraft] = useState(value)
  const local = validate === undefined ? null : validate(draft)
  const error = local ?? refused
  const commit = () => {
    // A rejected value stays in the box rather than being saved or silently
    // reverted — the operator can see what they typed and fix it.
    if (local !== null) return
    const v = draft.trim()
    if (v === value) return
    save({ [field]: nullable === true && v === '' ? null : v })
  }
  return (
    <Control edit={edit} field={field} error={error} saving={saving}>
      <Input
        id={id}
        type="text"
        aria-label={label}
        className={cn(INPUT, className)}
        value={draft}
        disabled={edit.committed === null}
        aria-invalid={error !== null}
        onChange={(e) => {
          setDraft(e.target.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(value)
        }}
      />
    </Control>
  )
}

/** A boolean field. Saves on toggle. */
export function SiteSwitch({
  edit,
  field,
  label,
}: {
  edit: SiteEdit
  field: SiteField
  label: string
}) {
  const checked = getSiteField(edit.desired, field) === true
  const { save, saving, refused } = useSiteSave()
  return (
    <Control edit={edit} field={field} error={refused} saving={saving}>
      <Chip tone={checked ? 'ok' : 'muted'}>{checked ? 'active' : 'off'}</Chip>
      <Switch
        aria-label={label}
        checked={checked}
        disabled={edit.committed === null || saving}
        onCheckedChange={(v) => {
          save({ [field]: v })
        }}
      />
    </Control>
  )
}

type ListProps = {
  edit: SiteEdit
  field: SiteField
  label: string
  validate?: (list: string[]) => string | null
}

/** A list field, one entry per line. Saves on blur (Enter is a new line). */
export function SiteList(props: ListProps) {
  const value = getSiteField(props.edit.desired, props.field)
  const list = Array.isArray(value) ? value.map(String) : []
  const text = list.join('\n')
  return <ListInner key={text} {...props} list={list} text={text} />
}

function ListInner({
  edit,
  field,
  label,
  validate,
  list,
  text,
}: ListProps & { list: string[]; text: string }) {
  const id = useId()
  const { save, saving, refused } = useSiteSave()
  const [draft, setDraft] = useState(text)
  const parsed = parseUpstreams(draft)
  const local = validate === undefined ? null : validate(parsed)
  const error = local ?? refused
  const commit = () => {
    if (local !== null) return
    if (JSON.stringify(parsed) === JSON.stringify(list)) return
    save({ [field]: parsed })
  }
  return (
    <Control edit={edit} field={field} error={error} saving={saving}>
      <Textarea
        id={id}
        aria-label={label}
        className={cn(INPUT, 'min-h-0 resize-none py-[0.45rem] leading-[1.5]')}
        value={draft}
        disabled={edit.committed === null}
        aria-invalid={error !== null}
        rows={Math.max(2, parsed.length + 1)}
        onChange={(e) => {
          setDraft(e.target.value)
        }}
        onBlur={commit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(text)
        }}
      />
    </Control>
  )
}

export type SelectGroupSpec = { label: string; options: { value: string; label: string }[] }

type SelectProps = {
  edit: SiteEdit
  /** The field the trigger shows, and whose provenance the row carries. */
  field: SiteField
  label: string
  groups: SelectGroupSpec[]
  /**
   * The patch a choice saves; the field alone by default. The domain uses it
   * to carry its zone id in the same request, because the two are one fact.
   */
  patchFor?: (value: string) => Partial<Record<SiteField, unknown>>
  /** No list to choose from yet, or none could be read. */
  disabled?: boolean
}

/** A closed list. Saves on choice. */
export function SiteSelect({ edit, field, label, groups, patchFor, disabled }: SelectProps) {
  const value = getSiteField(edit.desired, field)
  const current = typeof value === 'string' ? value : ''
  const { save, saving, refused } = useSiteSave()
  // A value the list does not carry (a zone the token stopped seeing, a name
  // tzdata renamed) is still shown, as its own group, rather than leaving an
  // empty trigger that reads as "not set".
  const known = groups.some((g) => g.options.some((o) => o.value === current))
  const shown =
    known || current === ''
      ? groups
      : [{ label: 'Current', options: [{ value: current, label: current }] }, ...groups]
  return (
    <Control edit={edit} field={field} error={refused} saving={saving}>
      <Select
        value={current}
        disabled={edit.committed === null || saving || disabled === true}
        onValueChange={(v) => {
          if (v === current) return
          save(patchFor === undefined ? { [field]: v } : patchFor(v))
        }}
      >
        <SelectTrigger size="sm" aria-label={label} className={cn(INPUT, 'justify-between')}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="max-h-80">
          {shown.map((g) => (
            <SelectGroup key={g.label}>
              {shown.length > 1 && <SelectLabel>{g.label}</SelectLabel>}
              {g.options.map((o) => (
                <SelectItem key={o.value} value={o.value} className="font-mono text-[0.8rem]">
                  {o.label}
                </SelectItem>
              ))}
            </SelectGroup>
          ))}
        </SelectContent>
      </Select>
    </Control>
  )
}

/** Shown on the editable tabs while site.json does not exist yet. */
export function SiteUnwritten({ edit }: { edit: SiteEdit }) {
  if (edit.committed !== null) return null
  return (
    <Alert variant="warning">
      <AlertDescription>
        <p className="m-0">
          <code>site/site.json</code> has not been written yet, so these fields are locked: there is
          no committed value for an edit to differ from. Write it once from the Site tab; after that
          a change here is a pending edit and Apply is what makes it real.
        </p>
      </AlertDescription>
    </Alert>
  )
}

const SUMMARY = cn(
  'flex min-w-0 cursor-pointer list-none flex-wrap items-baseline gap-x-3 gap-y-1 px-3 py-2',
  'text-[0.84rem] hover:bg-(--raise) [&::-webkit-details-marker]:hidden',
  "before:text-[0.7rem] before:text-muted-foreground before:transition-transform before:duration-[0.12s] before:content-['▸']",
  'group-open:before:rotate-90',
)

/** Stable keys for a diff's lines: a line's text and kind, disambiguated by
    how many identical ones came before it. */
function keyed(diff: readonly FoldedLine[]): { key: string; line: FoldedLine }[] {
  const seen = new Map<string, number>()
  return diff.map((line) => {
    const base = line.kind === 'fold' ? `fold:${String(line.count)}` : `${line.kind}:${line.text}`
    const n = seen.get(base) ?? 0
    seen.set(base, n + 1)
    return { key: `${base}#${String(n)}`, line }
  })
}

const SIGN: Record<DiffLine['kind'], string> = { same: ' ', add: '+', del: '−' }

/**
 * What an Apply would write to site.json, as a line diff against the file as
 * committed. Collapsed by default: the changed FIELDS are in the summary and
 * on the Apply bar; the bytes are for the reader who wants to see exactly
 * what the commit will contain. Unchanged runs are folded to three lines of
 * context so the change is in view when the box opens, not below it.
 */
export function SiteDiff({ edit }: { edit: SiteEdit }) {
  if (edit.changes.length === 0) return null
  const full = diffLines(edit.render.before ?? '', edit.render.after)
  const { added, removed } = diffCounts(full)
  const diff = foldUnchanged(full, 3)
  return (
    <details className="group overflow-hidden rounded-[9px] border border-(--border-soft) bg-card">
      <summary className={SUMMARY}>
        <span className="[font-weight:550]">Show what will be written</span>
        <span className="text-[0.76rem] text-(--dim)">
          <Mono className="text-[0.74rem]">site/site.json</Mono> · {edit.changes.join(', ')} ·{' '}
          <span className="text-success">+{added}</span>{' '}
          <span className="text-danger">−{removed}</span>
        </span>
        <span className="ml-auto text-[0.74rem] text-(--dim)">
          Nothing on the box changes until Apply rebuilds from it.
        </span>
      </summary>
      <pre className="m-0 max-h-80 overflow-auto border-t border-(--border-soft) bg-(--panel-2) px-3 py-2 font-mono text-[0.74rem] leading-[1.5]">
        {keyed(diff).map(({ key, line }) =>
          line.kind === 'fold' ? (
            <div key={key} className="-mx-1 flex gap-2 px-1 text-(--dim) italic">
              <span className="w-3 flex-none select-none">⋯</span>
              <span>
                {line.count} unchanged line{line.count === 1 ? '' : 's'}
              </span>
            </div>
          ) : (
            <div
              key={key}
              className={cn(
                '-mx-1 flex gap-2 rounded-[3px] px-1',
                line.kind === 'del' && 'bg-danger/10 text-danger',
                line.kind === 'add' && 'bg-success/10 text-success',
              )}
            >
              <span className="w-3 flex-none select-none text-(--dim)">{SIGN[line.kind]}</span>
              <span className="whitespace-pre">{line.text}</span>
            </div>
          ),
        )}
      </pre>
    </details>
  )
}
