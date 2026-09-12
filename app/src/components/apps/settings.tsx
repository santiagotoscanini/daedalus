import { useRouter } from '@tanstack/react-router'
import { type ReactNode, useId, useState } from 'react'
import { BASE_DOMAIN, hostnameError } from '../../lib/hostname'
import { defaultImage } from '../../lib/site'
import { deleteAppFn } from '../../server/registry'
import { Segmented, Slider, Toggle } from '../controls'
import { Alert, AlertDescription } from '../ui/alert'
import { Button } from '../ui/button'
import { Field, FieldDescription, FieldError, FieldLabel } from '../ui/field'
import { Input } from '../ui/input'
import { Board, BoardGrid, Facts } from '../viz'
import { BuildSettings } from './build-settings'
import { type AppRecord, BOARD_FOOT, type LoaderData } from './shared'

export function Settings({
  app,
  readOnly,
  patch,
  takenHostnames,
  stateRoot,
}: {
  app: AppRecord
  readOnly: boolean
  patch: (p: Record<string, unknown>) => void
  takenHostnames: NonNullable<LoaderData>['takenHostnames']
  /** `fleet.stateRoot` on the host, from the site export. */
  stateRoot: string
}) {
  return (
    <BoardGrid>
      <Board title="Platform" icon="◱" span={4}>
        <Toggle
          checked={app.postgres}
          disabled={readOnly}
          onChange={(v) => {
            patch({ postgres: v })
          }}
          label="Postgres"
          hint="Role + database on the shared cluster. Turning it off leaves the database in place."
        />
        <Toggle
          checked={app.storage}
          disabled={readOnly}
          onChange={(v) => {
            patch({ storage: v })
          }}
          label="Persistent storage"
          hint="Bind-mounts a data dir at /app/data."
        />
        <Toggle
          checked={app.litellm}
          disabled={readOnly}
          onChange={(v) => {
            patch({ litellm: v })
          }}
          label="LiteLLM gateway"
          hint="Injects LITELLM_BASE_URL. Does not hand over the master key."
        />
        <Toggle
          checked={app.prometheus}
          disabled={readOnly}
          onChange={(v) => {
            patch({ prometheus: v })
          }}
          label="Prometheus scrape"
          hint="Only turn on once the app actually serves /metrics. Otherwise it is a permanently-down target."
        />
        <Facts
          list
          rows={[
            {
              k: 'operator secrets',
              v: app.operatorSecrets ? (
                <code>{app.name}-env.sops</code>
              ) : (
                <span className="text-(--text-muted)">none</span>
              ),
            },
          ]}
        />
        <p className={BOARD_FOOT}>
          Secrets have no switch because the file is the switch: a tracked{' '}
          <code>stacks/apps/{app.name}-env.sops</code> is loaded into the container, and nothing
          else decides it. Author it with <code>sops</code>, <code>git add</code> it, and the next
          rebuild injects it.
        </p>
      </Board>

      <Board title="Routing" icon="⇢" span={4}>
        <TextField
          label="Hostname"
          value={app.hostname ?? ''}
          placeholder={`${app.name}.${BASE_DOMAIN}`}
          disabled={readOnly}
          validate={(v) => hostnameError(v, takenHostnames)}
          hint={
            <>
              Empty uses the default. Must be one level under <code>{BASE_DOMAIN}</code>, the only
              domain here with a wildcard certificate, a Cloudflare tunnel and DNS.
            </>
          }
          onSave={(v) => {
            patch({ hostname: v.trim() === '' ? null : v.trim().toLowerCase() })
          }}
        />
        <Facts list rows={[{ k: 'published at', v: <code>{app.effectiveHostname}</code> }]} />
        <p className={BOARD_FOOT}>
          Renaming moves the traefik router, the pi-hole record, the gatus probe, the Cloudflare
          route and <code>AUTH_URL</code>. The container, the database, the sops file and the GitHub
          repo stay keyed by <code>{app.name}</code>. An SSO app cannot complete a login for the
          moment between the rebuild and Pocket ID picking up the new redirect URI.
        </p>
      </Board>

      <Board title="Presentation" icon="✦" span={4}>
        <TextField
          label="Description"
          value={app.description}
          disabled={readOnly}
          onSave={(v) => {
            patch({ description: v })
          }}
        />
        {/* No icon field: the app publishes one and daedalus reads it. See
            lib/app-icon.ts — a column here could only ever agree or
            disagree with what the browser tab already shows. */}
        <TextField
          label="Image override"
          value={app.image ?? ''}
          placeholder={defaultImage(app.name)}
          disabled={readOnly || app.sourceMode === 'local'}
          onSave={(v) => {
            patch({ image: v.trim() === '' ? null : v.trim() })
          }}
        />
        {/* Beside the image override on purpose: the two are one workflow.
            A freeze without a pin only stops FUTURE digests — the current
            `:latest` re-resolves on any container recreate — so holding a
            known-good build means both. */}
        <Toggle
          checked={app.deployEnable}
          disabled={readOnly || app.sourceMode === 'local'}
          onChange={(v) => {
            patch({ deployEnable: v })
          }}
          label="Auto-deploy"
          hint="Poll the registry every 2 min and redeploy when the digest moves. Off freezes the app: the timer stops and the Redeploy button is refused host-side. Pair with a digest-pinned image override to hold a known-good build."
        />
      </Board>

      <Board title="Resource limits" icon="◴" span={6}>
        <Slider
          label="CPU"
          hint="cores the container may burn"
          value={app.limitCpus}
          min={0.25}
          max={8}
          step={0.25}
          disabled={readOnly}
          format={(v) => (
            <>
              {v} <small>{v === 1 ? 'core' : 'cores'}</small>
            </>
          )}
          onChange={(v) => {
            patch({ limitCpus: v })
          }}
        />
        <Slider
          label="Memory"
          hint="resident cap: pages spill to zram past it, OOM kill at twice it"
          value={app.limitMemoryMb}
          min={128}
          max={4096}
          step={128}
          disabled={readOnly}
          format={(v) => (
            <>
              {v} <small>MB</small>
            </>
          )}
          onChange={(v) => {
            patch({ limitMemoryMb: v })
          }}
        />
        <Slider
          label="Processes"
          hint="max processes + threads (fork-bomb guard)"
          value={app.limitPids}
          min={64}
          max={2048}
          step={64}
          disabled={readOnly}
          format={(v) => v}
          onChange={(v) => {
            patch({ limitPids: v })
          }}
        />
        <p className={BOARD_FOOT}>
          Enforced by cgroup v2, and only because systemd delegates <code>cpu io memory pids</code>{' '}
          down to <code>user@1000.service</code>. Without that, podman would accept the flags and
          the kernel would ignore them. CPU throttles rather than kills. Memory is the resident cap:
          pages past it spill to zram and the OOM kill lands at twice it, because podman writes{' '}
          <code>--memory-swap</code> through verbatim instead of subtracting. Takes effect on the
          next Apply, which restarts the container.
        </p>
      </Board>

      <Board title="Single sign-on" icon="key" span={6}>
        <Segmented
          value={app.authMode}
          disabled={readOnly}
          label="Single sign-on mode"
          onChange={(v) => {
            patch({ authMode: v })
          }}
          options={[
            { value: 'none', label: 'None', icon: '○' },
            {
              value: 'proxy',
              label: 'Forward-auth',
              icon: '⛨',
              // Both are assertions in stacks/apps/apps.nix. Greyed out with
              // the reason rather than accepted and failed mid-Apply.
              disabled: app.stage === 'off' || !app.authHealthPath,
              reason:
                app.stage === 'off'
                  ? 'Nothing to gate: the middleware is generated from the ingress, and this app is not exposed.'
                  : !app.authHealthPath
                    ? 'Set a health path first. It is the unauthenticated path the gate lets through, so the probe tests the app instead of the login redirect.'
                    : undefined,
            },
            { value: 'native', label: 'App is the client', icon: '⚿' },
          ]}
        />
        <p className={BOARD_FOOT}>
          {app.authMode === 'none'
            ? 'No SSO. Whatever login the app ships is the only one — for an app with its own accounts that means its own password form.'
            : app.authMode === 'proxy'
              ? 'traefik gates the router; the app never learns there is an IdP. For apps with no user model of their own.'
              : 'The app is the OIDC client: it gets OIDC_ISSUER_URL, OIDC_CLIENT_ID, OIDC_REDIRECT_URI, OIDC_PROVIDER_ID, OIDC_PROVIDER_NAME and OIDC_SCOPES, plus OIDC_CLIENT_SECRET from a rendered file. For apps with accounts of their own, which is what keeps per-user data isolated.'}
        </p>
        <TextField
          label="Health path"
          value={app.authHealthPath ?? ''}
          placeholder="/api/healthz"
          disabled={readOnly}
          hint="Unauthenticated path the app itself serves. Required for forward-auth; also what gatus probes."
          onSave={(v) => {
            patch({ authHealthPath: v.trim() === '' ? null : v.trim() })
          }}
        />
        <Facts
          list
          rows={[
            { k: 'client id', v: <code>{app.name}</code> },
            {
              k: 'redirect uri',
              v: (
                <code title={`https://${app.effectiveHostname}/api/auth/callback/pocket-id`}>
                  /api/auth/callback/pocket-id
                </code>
              ),
            },
          ]}
        />
        <p className={BOARD_FOOT}>
          The client is declared, not clicked: this materializes{' '}
          <code>fleet.ssoClients.{app.name}</code>, and a oneshot creates it at the IdP on the next
          Apply. Its secret is generated on the box the first time the client is declared, so there
          is nothing to author and nothing to paste back. Egress is not editable here at all:
          routing an app through a VPN needs a gluetun instance to exist first, and that is a stack
          of its own.
        </p>
      </Board>

      {/* Local-source apps run their working tree: nothing is built. */}
      {!readOnly && app.sourceMode !== 'local' && <BuildSettings app={app} />}

      {!readOnly && (
        <RemovePanel
          name={app.name}
          postgres={app.postgres}
          storage={app.storage}
          dataDir={`${stateRoot}/apps/${app.name}/data`}
        />
      )}
    </BoardGrid>
  )
}

/**
 * Remove the app from the registry.
 *
 * Confirm-by-typing rather than a dialog: the cost of this is not the click,
 * it is that the next Apply takes the app off the box, and typing the name is
 * the cheapest way to make sure the app being removed is the app you are
 * looking at.
 *
 * The honest part is the list of what does NOT go away. `deleteApp` removes a
 * declaration; the postgres database, the data directory and any sops file
 * outlive it, because a UI button should not be able to destroy data that
 * takes a restore to get back. Reclaiming them stays a deliberate act at a
 * shell, and the panel says so instead of leaving you to find out.
 */
function RemovePanel({
  name,
  postgres,
  storage,
  dataDir,
}: {
  name: string
  postgres: boolean
  storage: boolean
  dataDir: string
}) {
  const router = useRouter()
  const confirmId = useId()
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const remove = () => {
    setBusy(true)
    setError(null)
    void deleteAppFn({ data: { name } })
      .then(() => router.navigate({ to: '/apps' }))
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        setBusy(false)
      })
  }

  return (
    <Board title="Remove" icon="⌫" span={12}>
      {/* The explanation and the control side by side rather than stacked: what
          is NOT removed is the part worth reading, and it has to be in view at
          the moment the name is being typed rather than scrolled past to reach
          the box. */}
      <div className="grid grid-cols-[minmax(0,1fr)_minmax(15rem,20rem)] items-start gap-6 max-[50rem]:grid-cols-[minmax(0,1fr)]">
        <div className="[&>p]:mt-0 [&>p]:mr-0 [&>p]:mb-2 [&>p]:ml-0 [&>p]:text-[0.85rem] [&>p]:leading-[1.55] [&>p]:text-(--text-muted)">
          <p>
            Deletes the registry entry. The next Apply removes the container, the traefik router,
            the pi-hole record, the gatus probe, the Cloudflare route and this app’s CI runner.
          </p>
          <p className="mb-0 text-[0.73rem] leading-[1.45] text-(--dim)">
            <b>Not removed:</b>{' '}
            {[
              postgres && `the ${name} database and role on the shared cluster`,
              storage && dataDir,
              `stacks/apps/secrets/${name}/`,
              `any stacks/apps/${name}-env.sops`,
              'the GitHub repo and its published images',
            ]
              .filter((s): s is string => typeof s === 'string')
              .join(', ')}
            . Those are data, and removing them is a separate, deliberate act.
          </p>
        </div>
        <div className="flex flex-col items-stretch gap-[0.6rem]">
          <Field className="gap-[0.3rem] p-0 has-[:disabled]:opacity-100">
            <FieldLabel htmlFor={confirmId} className="text-[0.76rem] font-normal text-(--dim)">
              Type “{name}” to confirm
            </FieldLabel>
            <Input
              id={confirmId}
              type="text"
              className="h-auto rounded-[8px] bg-(--panel-2) px-[0.65rem] py-[0.45rem] md:text-[0.87rem] dark:bg-(--panel-2)"
              value={confirm}
              onChange={(e) => {
                setConfirm(e.target.value)
              }}
            />
          </Field>
          {error !== null && (
            <Alert variant="warning" className="mb-[1.35rem] text-foreground">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          {/* Destructive, and coloured like it — but only on hover, so the
              panel does not read as an alarm just for existing. */}
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="border-danger/50 bg-transparent text-[0.84rem] text-danger hover:bg-danger/12 hover:text-danger dark:bg-transparent"
            disabled={confirm !== name || busy}
            onClick={remove}
          >
            {busy ? 'Removing…' : 'Remove from registry'}
          </Button>
        </div>
      </div>
    </Board>
  )
}

/** Text input that commits on blur or Enter — no per-keystroke writes. */
function TextField({
  label,
  value,
  placeholder,
  hint,
  disabled,
  validate,
  onSave,
}: {
  label: string
  value: string
  placeholder?: string
  hint?: ReactNode
  disabled?: boolean
  /** Returns an operator-facing reason, or null when the value is usable. */
  validate?: (v: string) => string | null
  onSave: (v: string) => void
}) {
  const id = useId()
  const [draft, setDraft] = useState(value)
  const error = validate ? validate(draft) : null

  return (
    // `has-[:disabled]:opacity-100`: a disabled row dims its INPUT, not its
    // label — the label is what says which field is locked.
    <Field className="gap-[0.3rem] py-2 has-[:disabled]:opacity-100">
      <FieldLabel htmlFor={id} className="text-[0.76rem] font-normal text-(--dim)">
        {label}
      </FieldLabel>
      <Input
        id={id}
        type="text"
        className="h-auto rounded-[8px] bg-(--panel-2) px-[0.65rem] py-[0.45rem] md:text-[0.87rem] dark:bg-(--panel-2)"
        value={draft}
        placeholder={placeholder}
        disabled={disabled}
        aria-invalid={error !== null}
        onChange={(e) => {
          setDraft(e.target.value)
        }}
        onBlur={() => {
          // A rejected value stays in the box rather than being saved or
          // silently reverted — the operator can see what they typed and fix
          // it. Escape is the way out.
          if (error !== null) return
          if (draft !== value) onSave(draft)
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur()
          if (e.key === 'Escape') setDraft(value)
        }}
      />
      {error !== null ? (
        <FieldError className="text-[0.76rem] leading-[1.45]">{error}</FieldError>
      ) : (
        hint !== undefined && (
          <FieldDescription className="text-[0.76rem] leading-[1.45]">{hint}</FieldDescription>
        )
      )}
    </Field>
  )
}
