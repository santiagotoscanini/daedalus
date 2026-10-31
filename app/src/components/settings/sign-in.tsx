import { useState } from 'react'
import type { BoxSettings } from '../../core/settings/types'
import type { SiteEdit } from '../../core/site'
import { oidcIssuerError } from '../../lib/site-fields'
import { removeAppSecretFn, setAppSecretFn } from '../../server/registry'
import { testOidcIssuerFn } from '../../server/settings'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { useAction } from '../use-action'
import { ERROR_NOTE, Line, Mono, NOTE, NOTE_SHOWN, SECTIONS, Section, Stack, Value } from './shared'
import { SiteText, SiteUnwritten } from './site-fields'

// Settings › Sign-in: the identity provider people sign in with.
//
// A host running Pocket ID needs nothing here: it hands the app its own client
// (core/oidc-config.ts). A field filled in replaces the box's value for that
// field alone, which is how the box points at another provider.
//
// The fields are site edits and reach the app through an Apply. The secret is
// write-only, and takes the same Apply: the vault is committed at once, but the
// container reads it when it starts.

const SECRET_KEY = 'AUTH_OIDC_CLIENT_SECRET'
const SECRET_LABEL = {
  settings: 'Set here.',
  box: 'Generated on this box.',
  none: 'Not set.',
} as const

export function SignIn({ settings, edit }: { settings: BoxSettings; edit: SiteEdit }) {
  const s = settings.signIn
  return (
    <div className={SECTIONS}>
      <SiteUnwritten edit={edit} />
      <Section
        title="Identity provider"
        description={`Who signs people in. Only members of the admins group get a session. Leave a field blank to keep this box's own value.`}
        rows={[
          {
            k: 'In use',
            v: s.configured ? (
              <Line>
                <Value v={s.name} />
                <Mono>{s.issuer}</Mono>
              </Line>
            ) : (
              <span className={ERROR_NOTE}>Nobody can sign in: a field below is missing.</span>
            ),
          },
          {
            k: 'Issuer URL',
            v: (
              <Stack className="gap-1.5">
                <SiteText
                  edit={edit}
                  field="oidc.issuer"
                  label="Issuer URL"
                  placeholder={s.issuer ?? undefined}
                  validate={oidcIssuerError}
                />
                <IssuerTest fallback={s.issuer} edit={edit} />
              </Stack>
            ),
          },
          {
            k: 'Client ID',
            v: (
              <SiteText
                edit={edit}
                field="oidc.clientId"
                label="Client ID"
                placeholder={s.clientId ?? undefined}
              />
            ),
          },
          {
            k: 'Display name',
            v: <SiteText edit={edit} field="oidc.name" label="Display name" placeholder={s.name} />,
          },
          { k: 'Client secret', v: <SecretField source={s.secret} /> },
          { k: 'Callback URL', v: <Value v={s.callbackUrl} /> },
        ]}
      >
        <p className={NOTE}>
          Register the callback URL at the provider, and have it send a <Mono>groups</Mono> claim. A
          wrong value here locks you out until a rollback, so test the issuer before you Apply.
        </p>
      </Section>
    </div>
  )
}

function IssuerTest({ fallback, edit }: { fallback: string | null; edit: SiteEdit }) {
  const { run, busy, error } = useAction()
  const [found, setFound] = useState<string | null>(null)
  const issuer = edit.desired.oidc.issuer !== '' ? edit.desired.oidc.issuer : fallback
  return (
    <Line>
      <Button
        variant="outline"
        size="sm"
        disabled={busy || issuer === null}
        onClick={() => {
          setFound(null)
          if (issuer === null) return
          run(() => testOidcIssuerFn({ data: { issuer } }), {
            invalidate: false,
            onDone: (r) => {
              if (r.ok) setFound(r.value.authorizationEndpoint)
            },
          })
        }}
      >
        Test issuer
      </Button>
      {found !== null && <span className={NOTE_SHOWN}>Answers at {found}</span>}
      {error !== null && <span className={ERROR_NOTE}>{error}</span>}
    </Line>
  )
}

function SecretField({ source }: { source: BoxSettings['signIn']['secret'] }) {
  const { run, busy, error } = useAction()
  const [value, setValue] = useState('')
  const [done, setDone] = useState<string | null>(null)
  const finish = (word: string) => {
    setValue('')
    setDone(word)
  }
  return (
    <Stack className="gap-1.5">
      <span className={NOTE_SHOWN}>{SECRET_LABEL[source]}</span>
      <Line>
        <Input
          type="password"
          aria-label="Client secret"
          autoComplete="off"
          className="max-w-[20rem]"
          value={value}
          onChange={(e) => {
            setValue(e.target.value)
          }}
        />
        <Button
          variant="outline"
          size="sm"
          disabled={busy || value === ''}
          onClick={() => {
            run(() => setAppSecretFn({ data: { name: 'daedalus', key: SECRET_KEY, value } }), {
              onDone: () => {
                finish('Saved. Apply to use it.')
              },
            })
          }}
        >
          Save secret
        </Button>
        {source === 'settings' && (
          <Button
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => {
              run(() => removeAppSecretFn({ data: { name: 'daedalus', key: SECRET_KEY } }), {
                onDone: () => {
                  finish('Removed. Apply to go back to this box’s own.')
                },
              })
            }}
          >
            Remove
          </Button>
        )}
      </Line>
      {done !== null && <span className={NOTE_SHOWN}>{done}</span>}
      {error !== null && <span className={ERROR_NOTE}>{error}</span>}
    </Stack>
  )
}
