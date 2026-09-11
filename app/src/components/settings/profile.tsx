import { useRouter } from '@tanstack/react-router'
import { ExternalLinkIcon, KeyRoundIcon, LogOutIcon } from 'lucide-react'
import { useId, useRef, useState, useTransition } from 'react'

import type { BoxSettings, Profile, ProfilePatch, ProfileRead } from '../../core/settings/types'
import { cn } from '../../lib/cn'
import {
  lengthError,
  type PictureType,
  pictureFileError,
  usernameError,
} from '../../lib/profile-fields'
import { mailAddressError } from '../../lib/site-fields'
import { resetProfilePictureFn, saveProfileFn, uploadProfilePictureFn } from '../../server/profile'
import { Button, buttonVariants } from '../ui/button'
import { Card, CardContent } from '../ui/card'
import { Field, FieldDescription, FieldError, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Chip } from '../viz'
import { Mono, Pending, Section, Unset } from './shared'

// Settings › Profile — the person, where every other tab is the box.
//
// Laid out as a person's page rather than as the box's fact rows: the picture
// and the name first, large and together, then a plain form. The label-left,
// value-right rows the other tabs use put a portrait at the far right edge of
// the card, which reads as a table cell, not as someone.
//
// Pocket ID is the source (core/settings/profile.ts): these read and write the
// IdP account the signed-in person uses everywhere, so a save is an API call
// that lands at once — no draft, no Apply bar, nothing rebuilds. The one thing
// about the operator nix owns, the Linux account, keeps its own read-only card.

const INPUT = cn(
  'h-9 w-full rounded-[8px] bg-(--panel-2) px-3 md:text-[0.86rem] dark:bg-(--panel-2)',
)
const ASIDE = 'text-[0.74rem] text-(--dim)'
const NOTE = 'm-0 text-[0.78rem] text-(--text-muted)'

export function ProfileTab({
  operator,
  profile,
}: {
  operator: BoxSettings['general']['operator']
  /** Null while Pocket ID is being asked. */
  profile: ProfileRead | null
}) {
  return (
    <div className="flex flex-col gap-6">
      {profile === null ? (
        <Card>
          <CardContent className="py-8">
            <Pending />
          </CardContent>
        </Card>
      ) : profile.ok ? (
        <Account profile={profile.profile} />
      ) : (
        <Section title="Profile" icon="/icon-pocket-id.svg" mono>
          <p className={NOTE}>{profile.reason}</p>
        </Section>
      )}

      <Section
        title="On this box"
        icon="/icon-nixos.webp"
        rows={[
          {
            k: 'Linux account',
            v:
              operator.user === '' ? (
                <Unset />
              ) : (
                <span className="inline-flex flex-col items-end gap-[0.1rem]">
                  <Mono>{operator.user}</Mono>
                  {operator.group !== '' && <span className={ASIDE}>group {operator.group}</span>}
                </span>
              ),
          },
        ]}
      >
        <p className={NOTE}>
          The account every container on the box runs as. Nix creates it and checks it on every
          build, so it is changed in the configuration rather than here.
        </p>
      </Section>
    </div>
  )
}

function Account({ profile: p }: { profile: Profile }) {
  const fullName = [p.firstName, p.lastName].filter((s) => s !== '').join(' ')
  const name = p.displayName || fullName || p.username
  const locked = p.managedByLdap
  return (
    <>
      <Identity profile={p} name={name} locked={locked} />

      <Section
        title="Details"
        icon="/icon-pocket-id.svg"
        mono
        description="Saved to your Pocket ID account when you leave a field."
      >
        {locked && (
          <p className={NOTE}>
            This account is synced from LDAP, so Pocket ID refuses edits to it. Change it in the
            directory instead.
          </p>
        )}
        <div className="grid gap-x-5 gap-y-5 sm:grid-cols-2">
          <ProfileText
            field="firstName"
            label="First name"
            value={p.firstName}
            validate={lengthError(50)}
            disabled={locked}
          />
          <ProfileText
            field="lastName"
            label="Last name"
            value={p.lastName}
            validate={lengthError(50)}
            disabled={locked}
          />
          <ProfileText
            field="displayName"
            label="Display name"
            value={p.displayName}
            placeholder={fullName}
            validate={lengthError(100)}
            disabled={locked}
            hint="What apps show for you. Empty means your first and last name."
            className="sm:col-span-2"
          />
          <ProfileText
            field="username"
            label="Username"
            value={p.username}
            validate={usernameError}
            disabled={locked}
          />
          <ProfileText
            field="email"
            label="Email"
            value={p.email}
            validate={mailAddressError}
            disabled={locked}
            hint="Apps get the new address on their next sign-in. Alerts go to Integrations › Mail relay."
          />
        </div>
      </Section>

      <Section
        title="Sign-in"
        icon={<KeyRoundIcon />}
        description="Your passkeys are kept by Pocket ID, not by this box."
      >
        <div className="flex flex-wrap items-center gap-2">
          {p.accountUrl !== '' && (
            <a
              href={p.accountUrl}
              target="_blank"
              rel="noreferrer"
              className={buttonVariants({ variant: 'outline', size: 'sm' })}
            >
              Manage passkeys
              <ExternalLinkIcon />
            </a>
          )}
          {/* A full page load: /logout belongs to the forward-auth middleware. */}
          <a href="/logout" className={buttonVariants({ variant: 'ghost', size: 'sm' })}>
            <LogOutIcon />
            Sign out
          </a>
        </div>
      </Section>
    </>
  )
}

async function toBase64(file: File): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  let binary = ''
  // In slices: spreading a whole photo into one call overflows the stack.
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
  }
  return btoa(binary)
}

/** The picture and the name, together — the part of the page that is the person. */
function Identity({
  profile: p,
  name,
  locked,
}: {
  profile: Profile
  name: string
  locked: boolean
}) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  // The picture's URL carries `pictureVersion`, which the server bumps on a
  // change; invalidating the router is what fetches it, here and in the rail.
  const run = (work: () => Promise<unknown>) => {
    setError(null)
    start(async () => {
      try {
        await work()
        await router.invalidate()
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
      }
    })
  }

  const onFile = (file: File | undefined) => {
    if (file === undefined) return
    const problem = pictureFileError(file.type, file.size)
    if (problem !== null) {
      setError(problem)
      return
    }
    run(async () =>
      uploadProfilePictureFn({
        data: { contentType: file.type as PictureType, base64: await toBase64(file) },
      }),
    )
  }

  return (
    <Card>
      <CardContent className="flex items-center gap-6 py-6 max-sm:flex-col max-sm:text-center">
        <img
          src={`/api/profile-picture?v=${String(p.pictureVersion)}`}
          alt={name}
          width={112}
          height={112}
          className="size-28 flex-none rounded-full border border-(--border-soft) object-cover"
        />
        <div className="flex min-w-0 flex-col gap-1 max-sm:items-center">
          <h2 className="m-0 truncate font-semibold text-[1.4rem] leading-tight tracking-[-0.01em]">
            {name}
          </h2>
          <p className="m-0 truncate text-(--text-muted) text-[0.88rem]">{p.username}</p>
          {p.email !== '' && (
            <p className="m-0 truncate text-(--text-muted) text-[0.88rem]">{p.email}</p>
          )}
          {(p.isAdmin || p.groups.length > 0) && (
            <div className="mt-1.5 flex flex-wrap gap-1.5 max-sm:justify-center">
              {p.isAdmin && <Chip tone="ok">Pocket ID admin</Chip>}
              {p.groups.map((g) => (
                <Chip key={g} tone="muted">
                  {g}
                </Chip>
              ))}
            </div>
          )}
          <div className="mt-3 flex flex-wrap items-center gap-2 max-sm:justify-center">
            <input
              ref={fileInput}
              type="file"
              accept="image/png,image/jpeg"
              className="sr-only"
              tabIndex={-1}
              aria-hidden
              onChange={(e) => {
                onFile(e.target.files?.[0])
                e.target.value = ''
              }}
            />
            <Button
              variant="outline"
              size="sm"
              disabled={locked || busy}
              onClick={() => fileInput.current?.click()}
            >
              {busy ? 'Saving…' : 'Change picture'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={locked || busy}
              onClick={() => {
                run(() => resetProfilePictureFn())
              }}
            >
              Remove
            </Button>
            <span className={ASIDE}>PNG or JPEG, up to 5 MB</span>
          </div>
          {error !== null && (
            <p role="alert" className="m-0 text-[0.78rem] text-destructive">
              {error}
            </p>
          )}
        </div>
      </CardContent>
    </Card>
  )
}

type TextProps = {
  field: keyof ProfilePatch
  label: string
  value: string
  validate: (v: string) => string | null
  disabled: boolean
  placeholder?: string
  hint?: string
  className?: string
}

/** Saves on blur or Enter; Escape puts the saved value back. */
function ProfileText(props: TextProps) {
  // Keyed on the saved value: a save remounts the box with what Pocket ID now
  // holds, and a refused save — value unchanged — keeps what was typed.
  return <TextInner key={props.value} {...props} />
}

function TextInner({
  field,
  label,
  value,
  validate,
  disabled,
  placeholder,
  hint,
  className,
}: TextProps) {
  const id = useId()
  const router = useRouter()
  const [draft, setDraft] = useState(value)
  const [saving, start] = useTransition()
  const [refused, setRefused] = useState<string | null>(null)
  const local = validate(draft)
  const error = local ?? refused
  const commit = () => {
    if (local !== null) return
    const v = draft.trim()
    if (v === value) return
    setRefused(null)
    start(async () => {
      try {
        const patch: ProfilePatch = { [field]: v }
        await saveProfileFn({ data: patch })
        await router.invalidate()
      } catch (e) {
        setRefused(e instanceof Error ? e.message : String(e))
      }
    })
  }
  return (
    <Field invalid={error !== null} className={cn('gap-1.5', className)}>
      <div className="flex items-baseline justify-between gap-2">
        <FieldLabel htmlFor={id} className="font-medium text-(--text-muted) text-[0.8rem]">
          {label}
        </FieldLabel>
        {saving && <span className={ASIDE}>Saving…</span>}
      </div>
      <Input
        id={id}
        type={field === 'email' ? 'email' : 'text'}
        className={INPUT}
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
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
      {error !== null ? (
        <FieldError className="text-[0.76rem]">{error}</FieldError>
      ) : (
        hint !== undefined && (
          <FieldDescription className="text-(--dim) text-[0.76rem]">{hint}</FieldDescription>
        )
      )}
    </Field>
  )
}
