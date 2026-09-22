import { useRouter } from '@tanstack/react-router'
import { GlobeIcon } from 'lucide-react'
import { useId, useState, useTransition } from 'react'
import { cn } from '../../lib/cn'
import {
  EXTERNAL_DESCRIPTION_MAX,
  EXTERNAL_NAME_MAX,
  type ExternalApp,
  type ExternalAppInput,
  externalAppError,
  isPlatform,
  PLATFORMS,
  type Platform,
} from '../../lib/external-apps'
import { errorText } from '../../lib/redact'
import { addExternalAppFn, removeExternalAppFn } from '../../server/settings'
import { Button } from '../ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '../ui/select'
import { Chip } from '../viz'
import { ERROR_NOTE, Mono, NOTE, PANEL, Section } from './shared'

// The projects hosted off this box, as the Apps page lists them.
//
// A preference of the theme's kind — a row in Postgres, saved on click, no
// Apply bar — and the one list on Settings the operator fills in by hand:
// nothing on the box knows these sites exist, so nothing can derive them.
// Add and remove, no edit-in-place: a row is five short strings, and
// retyping one is quicker than a second form that has to know which field
// changed. The rules the form checks live in lib/external-apps.ts; the
// server runs the same ones over the real lists and adds the collision only
// it can see (a registry app of the same name).

const EMPTY: ExternalAppInput = {
  name: '',
  host: '',
  platform: PLATFORMS[0].id,
  description: '',
  repo: null,
}

const INPUT = cn(
  'h-auto w-full rounded-[8px] bg-(--panel-2) px-[0.65rem] py-[0.4rem]',
  'font-mono md:text-[0.8rem] dark:bg-(--panel-2)',
)
const LABEL = 'font-medium text-(--text-muted) text-[0.8rem]'
const HINT = 'text-(--dim) text-[0.76rem]'

export function ExternalApps({ rows }: { rows: ExternalApp[] }) {
  const ids = {
    name: useId(),
    host: useId(),
    platform: useId(),
    description: useId(),
    repo: useId(),
  }
  const router = useRouter()
  const [draft, setDraft] = useState<ExternalAppInput>(EMPTY)
  const [touched, setTouched] = useState(false)
  const [busy, start] = useTransition()
  const [refused, setRefused] = useState<string | null>(null)

  // The form's own verdict, over the rows it can see; shown once the operator
  // has started typing, so an empty form is not a wall of red.
  const local = externalAppError(
    draft,
    rows.map((r) => r.id),
  )
  const error = touched ? (local ?? refused) : refused
  const patch = (p: Partial<ExternalAppInput>) => {
    setTouched(true)
    setRefused(null)
    setDraft((d) => ({ ...d, ...p }))
  }

  const add = () => {
    if (local !== null) {
      setTouched(true)
      return
    }
    setRefused(null)
    start(async () => {
      try {
        const r = await addExternalAppFn({ data: draft })
        if (r.ok) {
          setDraft(EMPTY)
          setTouched(false)
          await router.invalidate()
        } else setRefused(r.reason)
      } catch (e) {
        setRefused(errorText(e))
      }
    })
  }

  const remove = (id: string) => {
    setRefused(null)
    start(async () => {
      try {
        const r = await removeExternalAppFn({ data: { id } })
        if (!r.ok) setRefused(r.reason)
        await router.invalidate()
      } catch (e) {
        setRefused(errorText(e))
      }
    })
  }

  return (
    <Section
      title="Projects off the box"
      icon={<GlobeIcon />}
      description="Sites hosted elsewhere — GitHub Pages, Vercel — listed on the Apps page beside what this box runs. Nothing here builds, serves or watches them."
    >
      {rows.length === 0 ? (
        <p className={NOTE}>No projects listed. The Apps page shows only what this box runs.</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {rows.map((r) => (
            <li
              key={r.id}
              className="flex flex-wrap items-center justify-between gap-2 border-(--border-soft) border-b pb-2 last:border-0"
            >
              <span className="inline-flex min-w-0 flex-col gap-[0.1rem]">
                <span className="inline-flex items-center gap-2">
                  <span className="font-medium text-[0.82rem]">{r.name}</span>
                  <Chip tone="muted">{r.platform}</Chip>
                </span>
                <span className="text-[0.72rem] text-(--dim)">
                  <Mono>{r.host}</Mono>
                  {r.repo !== null && (
                    <>
                      {' · '}
                      <Mono>{r.repo}</Mono>
                    </>
                  )}
                </span>
              </span>
              <Button variant="outline" size="sm" disabled={busy} onClick={() => remove(r.id)}>
                Remove
              </Button>
            </li>
          ))}
        </ul>
      )}

      <div className={PANEL}>
        <div className="grid gap-3 md:grid-cols-2">
          <Field className="gap-1.5">
            <FieldLabel htmlFor={ids.name} className={LABEL}>
              Name
            </FieldLabel>
            <Input
              id={ids.name}
              className={INPUT}
              value={draft.name}
              maxLength={EXTERNAL_NAME_MAX}
              placeholder="my-site"
              onChange={(e) => patch({ name: e.target.value })}
            />
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor={ids.host} className={LABEL}>
              Hostname
            </FieldLabel>
            <Input
              id={ids.host}
              className={INPUT}
              value={draft.host}
              placeholder="docs.example.org"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => patch({ host: e.target.value })}
            />
            <FieldDescription className={HINT}>
              Where it is served. The row links to <Mono>https://</Mono>this, and its icon is probed
              there.
            </FieldDescription>
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor={ids.platform} className={LABEL}>
              Platform
            </FieldLabel>
            <Select
              value={draft.platform}
              onValueChange={(v) => {
                if (isPlatform(v)) patch({ platform: v })
              }}
            >
              <SelectTrigger
                id={ids.platform}
                size="sm"
                className={cn(INPUT, 'justify-between')}
                aria-label="Platform"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {PLATFORMS.map((p) => (
                  <SelectItem key={p.id} value={p.id} className="font-mono text-[0.8rem]">
                    {p.id}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <FieldDescription className={HINT}>{platformNote(draft.platform)}</FieldDescription>
          </Field>
          <Field className="gap-1.5">
            <FieldLabel htmlFor={ids.repo} className={LABEL}>
              Repository
            </FieldLabel>
            <Input
              id={ids.repo}
              className={INPUT}
              value={draft.repo ?? ''}
              placeholder="owner/name"
              autoCapitalize="none"
              spellCheck={false}
              onChange={(e) => patch({ repo: e.target.value === '' ? null : e.target.value })}
            />
            <FieldDescription className={HINT}>
              Optional. The full GitHub slug, wherever it lives — it is what the repo link and the
              clone button act on.
            </FieldDescription>
          </Field>
          <Field className="gap-1.5 md:col-span-2">
            <FieldLabel htmlFor={ids.description} className={LABEL}>
              Description
            </FieldLabel>
            <Input
              id={ids.description}
              className={INPUT}
              value={draft.description}
              maxLength={EXTERNAL_DESCRIPTION_MAX}
              placeholder="One line, as the Apps page shows it."
              onChange={(e) => patch({ description: e.target.value })}
            />
          </Field>
        </div>
        {error !== null && <FieldError className={ERROR_NOTE}>{error}</FieldError>}
        <div>
          <Button size="sm" disabled={busy} onClick={add}>
            Add
          </Button>
        </div>
      </div>
    </Section>
  )
}

function platformNote(p: Platform): string {
  return PLATFORMS.find((x) => x.id === p)?.description ?? ''
}
