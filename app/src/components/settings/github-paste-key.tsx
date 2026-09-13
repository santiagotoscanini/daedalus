import { useRouter } from '@tanstack/react-router'
import { ExternalLinkIcon } from 'lucide-react'
import { useId, useState, useTransition } from 'react'

import { pasteAppKeyFn } from '../../server/settings'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Textarea } from '../ui/textarea'
import { ERROR_NOTE, FIELD_LABEL, NOTE, PANEL, WAITING_FOR_HOST } from './shared'

// The GitHub App's recovery form, and only that.
//
// Split out from the App section beside it because it is the one place on this
// page where three secrets are typed in at once. Everything else under GitHub
// reports state; this hands the box credentials, so the rules that keep them
// from lingering — cleared on submit, never read back — are easier to hold to
// when nothing else shares the file.

/**
 * Recovery: a new private key for the App site.json names. The three values
 * are typed here, sent once, and cleared on submit; nothing comes back.
 */
export function PasteKey({
  enabled,
  settingsUrl,
}: {
  enabled: boolean
  settingsUrl: string | undefined
}) {
  const pemId = useId()
  const webhookId = useId()
  const clientId = useId()
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [pem, setPem] = useState('')
  const [webhookSecret, setWebhookSecret] = useState('')
  const [clientSecret, setClientSecret] = useState('')
  const [busy, start] = useTransition()
  const [outcome, setOutcome] = useState<{ ok: boolean; text: string } | null>(null)

  const clear = () => {
    setPem('')
    setWebhookSecret('')
    setClientSecret('')
  }
  const ready = enabled && !busy && pem.trim() !== '' && webhookSecret !== '' && clientSecret !== ''

  const submit = () => {
    if (!ready) return
    const data = { pem, webhookSecret, clientSecret }
    clear()
    setOutcome(null)
    start(async () => {
      try {
        const r = await pasteAppKeyFn({ data })
        if (r.ok) {
          setOpen(false)
          setOutcome({
            ok: true,
            text: 'Encrypted and applying. The new webhook secret has to be saved on GitHub too.',
          })
          await router.invalidate()
        } else {
          setOutcome({ ok: false, text: r.reason })
        }
      } catch (e) {
        setOutcome({ ok: false, text: e instanceof Error ? e.message : String(e) })
      }
    })
  }

  if (!open) {
    return (
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="-ml-2"
          onClick={() => {
            setOpen(true)
            setOutcome(null)
          }}
        >
          Paste a private key…
        </Button>
        {outcome !== null && <span className={outcome.ok ? NOTE : ERROR_NOTE}>{outcome.text}</span>}
      </div>
    )
  }

  return (
    <form
      className={PANEL}
      onSubmit={(e) => {
        e.preventDefault()
        submit()
      }}
    >
      <p className={NOTE}>
        For a lost or rotated key. The box keeps the key, the webhook secret and the client secret
        in one sealed file it cannot read back, so all three are replaced together. On the App’s
        settings page, generate a private key and a new client secret, and set a new webhook secret
        there as well: deliveries fail to verify while the two sides disagree.
      </p>
      <label htmlFor={pemId} className={FIELD_LABEL}>
        Private key
      </label>
      <Textarea
        id={pemId}
        rows={6}
        value={pem}
        disabled={!enabled}
        spellCheck={false}
        autoComplete="off"
        placeholder="-----BEGIN RSA PRIVATE KEY-----"
        onChange={(e) => {
          setPem(e.target.value)
        }}
        className="max-h-60 font-mono text-[0.74rem] md:text-[0.74rem]"
      />
      <div className="grid gap-2 sm:grid-cols-2">
        <div className="flex flex-col gap-1">
          <label htmlFor={webhookId} className={FIELD_LABEL}>
            Webhook secret
          </label>
          <Input
            id={webhookId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={webhookSecret}
            disabled={!enabled}
            onChange={(e) => {
              setWebhookSecret(e.target.value)
            }}
            className="h-9 font-mono md:text-[0.8rem]"
          />
        </div>
        <div className="flex flex-col gap-1">
          <label htmlFor={clientId} className={FIELD_LABEL}>
            Client secret
          </label>
          <Input
            id={clientId}
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={clientSecret}
            disabled={!enabled}
            onChange={(e) => {
              setClientSecret(e.target.value)
            }}
            className="h-9 font-mono md:text-[0.8rem]"
          />
        </div>
      </div>
      {!enabled && <p className={NOTE}>{WAITING_FOR_HOST}</p>}
      {outcome !== null && !outcome.ok && (
        <p role="alert" className={ERROR_NOTE}>
          {outcome.text}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={!ready}>
          {busy ? 'Encrypting…' : 'Encrypt and apply'}
        </Button>
        {settingsUrl !== undefined && (
          <Button asChild variant="outline" size="sm">
            <a href={settingsUrl} target="_blank" rel="noreferrer">
              App settings
              <ExternalLinkIcon />
            </a>
          </Button>
        )}
        <Button
          type="button"
          variant="ghost"
          size="sm"
          onClick={() => {
            setOpen(false)
            clear()
          }}
        >
          Cancel
        </Button>
      </div>
    </form>
  )
}
