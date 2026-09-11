import { useRouter } from '@tanstack/react-router'
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
import { Button } from '../ui/button'
import { Field, FieldError } from '../ui/field'
import { Input } from '../ui/input'
import { Chip } from '../viz'
import { ExtLink, Mono, Pending, Section, Unset } from './shared'

// Settings › Profile — the person, where every other tab is the box.
//
// Pocket ID is the source (core/settings/profile.ts): these rows read and write
// the IdP account the signed-in person uses everywhere, so a save is an API
// call that lands at once — no draft, no Apply bar, nothing rebuilds. The one
// thing about the operator that nix DOES own, the Linux account the fleet runs
// as, sits in its own section and stays read-only.

const INPUT = cn(
  'h-auto w-[15rem] max-w-full rounded-[8px] bg-(--panel-2) px-[0.65rem] py-[0.4rem]',
  'md:text-[0.8rem] dark:bg-(--panel-2)',
)
const ASIDE = 'text-[0.72rem] text-(--dim)'
const NOTE = 'm-0 text-[0.78rem] text-(--text-muted)'
const DESCRIPTION =
  'Your Pocket ID account: the name, email and picture every sign-in on this box shows. An edit saves to Pocket ID straight away; nothing rebuilds.'

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
        <Section title="Profile" description={DESCRIPTION}>
          <Pending />
        </Section>
      ) : profile.ok ? (
        <Account profile={profile.profile} />
      ) : (
        <Section title="Profile" description={DESCRIPTION}>
          <p className={NOTE}>{profile.reason}</p>
        </Section>
      )}

      <Section
        title="On this box"
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
    <Section
      title="Profile"
      description={DESCRIPTION}
      rows={[
        { k: 'Picture', v: <Picture name={name} disabled={locked} /> },
        {
          k: 'First name',
          v: (
            <ProfileText
              field="firstName"
              label="First name"
              value={p.firstName}
              validate={lengthError(50)}
              disabled={locked}
            />
          ),
        },
        {
          k: 'Last name',
          v: (
            <ProfileText
              field="lastName"
              label="Last name"
              value={p.lastName}
              validate={lengthError(50)}
              disabled={locked}
            />
          ),
        },
        {
          k: 'Display name',
          v: (
            <ProfileText
              field="displayName"
              label="Display name"
              value={p.displayName}
              placeholder={fullName}
              validate={lengthError(100)}
              disabled={locked}
            />
          ),
        },
        {
          k: 'Username',
          v: (
            <ProfileText
              field="username"
              label="Username"
              value={p.username}
              validate={usernameError}
              disabled={locked}
            />
          ),
        },
        {
          k: 'Email',
          v: (
            <ProfileText
              field="email"
              label="Email"
              value={p.email}
              validate={mailAddressError}
              disabled={locked}
            />
          ),
        },
        {
          k: 'Access',
          v:
            !p.isAdmin && p.groups.length === 0 ? (
              <Unset label="no groups" />
            ) : (
              <span className="inline-flex flex-wrap items-center justify-end gap-2">
                {p.isAdmin && <Chip tone="ok">Pocket ID admin</Chip>}
                {p.groups.map((g) => (
                  <Chip key={g} tone="muted">
                    {g}
                  </Chip>
                ))}
              </span>
            ),
        },
        {
          k: 'Passkeys',
          v:
            p.accountUrl === '' ? (
              <Unset />
            ) : (
              <ExtLink href={p.accountUrl}>manage in Pocket ID</ExtLink>
            ),
        },
      ]}
    >
      {locked && (
        <p className={NOTE}>
          This account is synced from LDAP, so Pocket ID refuses edits to it; change it in the
          directory instead.
        </p>
      )}
      <p className={NOTE}>
        The email is the address every app on the box receives for you, from its next sign-in on.
        Where alerts are sent is separate: Integrations › Mail relay.
      </p>
    </Section>
  )
}

type TextProps = {
  field: keyof ProfilePatch
  label: string
  value: string
  validate: (v: string) => string | null
  disabled: boolean
  placeholder?: string
}

/** Saves on blur or Enter; Escape puts the saved value back. */
function ProfileText(props: TextProps) {
  // Keyed on the saved value: a save remounts the box with what Pocket ID now
  // holds, and a refused save — value unchanged — keeps what was typed.
  return <TextInner key={props.value} {...props} />
}

function TextInner({ field, label, value, validate, disabled, placeholder }: TextProps) {
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
    <Field invalid={error !== null} className="w-auto items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-2">
        {saving && <span className={ASIDE}>saving…</span>}
        <Input
          id={id}
          type={field === 'email' ? 'email' : 'text'}
          aria-label={label}
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
      </div>
      {error !== null && (
        <FieldError className="max-w-[24rem] text-right text-[0.74rem] leading-[1.45]">
          {error}
        </FieldError>
      )}
    </Field>
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

function Picture({ name, disabled }: { name: string; disabled: boolean }) {
  const router = useRouter()
  const fileInput = useRef<HTMLInputElement>(null)
  // Bumped after every change so the <img> asks again; the route answers
  // no-cache, this is what makes the browser actually ask.
  const [version, setVersion] = useState(0)
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)

  const run = (work: () => Promise<unknown>) => {
    setError(null)
    start(async () => {
      try {
        await work()
        setVersion((v) => v + 1)
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
    <Field invalid={error !== null} className="w-auto items-end gap-1">
      <div className="flex flex-wrap items-center justify-end gap-3">
        {busy && <span className={ASIDE}>saving…</span>}
        <img
          src={`/api/profile-picture?v=${String(version)}`}
          alt={name}
          width={56}
          height={56}
          className="size-14 flex-none rounded-full border border-(--border-soft) object-cover"
        />
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
          disabled={disabled || busy}
          onClick={() => fileInput.current?.click()}
        >
          Upload…
        </Button>
        <Button
          variant="ghost"
          size="sm"
          disabled={disabled || busy}
          onClick={() => {
            run(() => resetProfilePictureFn())
          }}
        >
          Reset
        </Button>
      </div>
      {error !== null && (
        <FieldError className="max-w-[24rem] text-right text-[0.74rem] leading-[1.45]">
          {error}
        </FieldError>
      )}
    </Field>
  )
}
