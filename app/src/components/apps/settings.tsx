import type { AppPatch } from '../../lib/apps/validate'
import { hostnameError } from '../../lib/hostname'
import { defaultImage } from '../../lib/site'
import { useSite } from '../../lib/site-context'
import { stageExposed } from '../../lib/stage'
import { Segmented } from '../controls'
import { Slider, Toggle } from '../slider'
import { FOOT } from '../tokens'
import { Board, BoardGrid, Facts } from '../viz'
import { BuildSettings } from './build-settings'
import { RemovePanel, TextField } from './remove-panel'
import type { AppRecord, LoaderData } from './shared'

export function Settings({
  app,
  readOnly,
  patch,
  takenHostnames,
  stateRoot,
}: {
  app: AppRecord
  readOnly: boolean
  patch: (p: AppPatch) => void
  takenHostnames: NonNullable<LoaderData>['takenHostnames']
  /** `fleet.stateRoot` on the host, from the site export. */
  stateRoot: string
}) {
  const site = useSite()
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
                <span className="text-subdued">none</span>
              ),
            },
          ]}
        />
        <p className={FOOT}>
          Secrets have no switch because the file is the switch: a tracked{' '}
          <code>stacks/apps/{app.name}-env.sops</code> is loaded into the container, and nothing
          else decides it. Author it with <code>sops</code>, <code>git add</code> it, and the next
          rebuild injects it. A value that is not secret belongs on <b>Variables</b>, where it can
          be read and edited.
        </p>
      </Board>

      <Board title="Routing" icon="⇢" span={4}>
        <TextField
          label="Hostname"
          value={app.hostname ?? ''}
          placeholder={`${app.name}.${site.baseDomain}`}
          disabled={readOnly}
          validate={(v) => hostnameError(site, v, takenHostnames)}
          hint={
            <>
              Empty uses the default. Must be one level under <code>{site.baseDomain}</code>, the
              only domain here with a wildcard certificate, a Cloudflare tunnel and DNS.
            </>
          }
          onSave={(v) => {
            patch({ hostname: v.trim() === '' ? null : v.trim().toLowerCase() })
          }}
        />
        <Facts list rows={[{ k: 'published at', v: <code>{app.effectiveHostname}</code> }]} />
        <p className={FOOT}>
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
            host/app-icon.ts — a column here could only ever agree or
            disagree with what the browser tab already shows. */}
        <TextField
          label="Image override"
          value={app.image ?? ''}
          placeholder={defaultImage(site, app.name)}
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
        <p className={FOOT}>
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
              // Both are nix assertions (the ingress one in
              // nix/modules/apps/apps.nix, the health path in
              // platform/publishing.nix). Greyed out with the reason rather
              // than accepted and failed mid-Apply.
              disabled: !stageExposed(app.stage) || !app.authHealthPath,
              reason: !stageExposed(app.stage)
                ? app.stage === 'declared'
                  ? 'Nothing to gate: this app is declared only — no container, no ingress. Promote it first.'
                  : 'Nothing to gate: the middleware is generated from the ingress, and this app is not exposed.'
                : !app.authHealthPath
                  ? 'Set a health path first. It is the unauthenticated path the gate lets through, so the probe tests the app instead of the login redirect.'
                  : undefined,
            },
            { value: 'native', label: 'App is the client', icon: '⚿' },
          ]}
        />
        <p className={FOOT}>
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
        <p className={FOOT}>
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
