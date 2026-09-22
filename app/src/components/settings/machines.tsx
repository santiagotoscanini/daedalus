import { Link, useRouter } from '@tanstack/react-router'
import { MonitorSmartphoneIcon } from 'lucide-react'
import { useState, useTransition } from 'react'

import type { NodePolicy } from '../../host/schema'
import { cn } from '../../lib/cn'
import { since } from '../../lib/format'
import { errorText } from '../../lib/redact'
import type { NodeRow } from '../../lib/repo/nodes'
import { requestClaudeRestartFn, saveNodePolicyFn } from '../../server/nodes'
import { Button } from '../ui/button'
import { Input } from '../ui/input'
import { Switch } from '../ui/switch'
import { Chip } from '../viz'
import { ASIDE, ERROR_NOTE, Mono, NOTE, Section, Stack } from './shared'

// Settings › Machines — what the box wants of each machine that runs the
// agent, as opposed to what the machine IS (System › Machines shows that,
// and holds the approve/revoke decision).
//
// The second kind of setting on this page: Postgres, not site/. A policy
// travels to its machine on the answer to the agent's next hello, so a
// switch here reaches the machine within a minute and nothing rebuilds —
// which is why each row saves on click, like Appearance, with no Apply bar.
//
// A pending machine is listed but its switches are quiet: the box does not
// send a policy to a machine it has not approved, and saying so here beats a
// switch that appears to do nothing.

/** The agent's own defaults, which a key the policy leaves unset falls back to. */
const DEFAULTS = { awakeHold: true, claudeRemoteControl: true } as const

function osMark(os: string): { src: string; invert: boolean } | null {
  switch (os) {
    case 'windows':
      return { src: '/icon-windows.svg', invert: false }
    case 'macos':
      return { src: '/icon-apple.svg', invert: true }
    case 'linux':
      return { src: '/icon-linux.svg', invert: true }
    default:
      return null
  }
}

function MachineSection({ n }: { n: NodeRow }) {
  const router = useRouter()
  const [busy, start] = useTransition()
  const [error, setError] = useState<string | null>(null)
  // The name is typed, so it is held here and saved on blur or Enter; the
  // switches save on click.
  const [name, setName] = useState(n.policy.displayName ?? '')

  const save = (policy: NodePolicy) => {
    setError(null)
    start(async () => {
      try {
        await saveNodePolicyFn({ data: { id: n.id, policy } })
        await router.invalidate()
      } catch (e) {
        setError(errorText(e))
      }
    })
  }
  const saveName = () => {
    const trimmed = name.trim()
    if (trimmed === (n.policy.displayName ?? '')) return
    const { displayName: _old, ...rest } = n.policy
    save(trimmed === '' ? rest : { ...rest, displayName: trimmed })
  }
  const restartClaude = () => {
    setError(null)
    start(async () => {
      try {
        await requestClaudeRestartFn({ data: { id: n.id } })
        await router.invalidate()
      } catch (e) {
        setError(errorText(e))
      }
    })
  }

  const approved = n.state === 'approved'
  const awake = n.policy.awakeHold ?? DEFAULTS.awakeHold
  const claude = n.policy.claudeRemoteControl ?? DEFAULTS.claudeRemoteControl
  const mark = osMark(n.os)
  const state =
    n.state === 'approved' ? (
      <Chip tone="ok">approved</Chip>
    ) : n.state === 'pending' ? (
      <Chip tone="warn">not approved yet</Chip>
    ) : (
      <Chip tone="bad">revoked</Chip>
    )

  return (
    <Section
      title={n.name}
      icon={
        mark === null ? (
          <MonitorSmartphoneIcon />
        ) : (
          <img
            src={mark.src}
            alt=""
            width={20}
            height={20}
            className={cn('size-5 flex-none object-contain', mark.invert && 'dark:invert')}
          />
        )
      }
      description={
        <span className="inline-flex flex-wrap items-center gap-2">
          {state}
          <span>
            {n.hostname} · agent {n.agentVersion} · last hello {since(n.lastSeenAgo)}
          </span>
        </span>
      }
      rows={[
        {
          k: 'Display name',
          v: (
            <Stack className="w-full max-w-[22rem]">
              <Input
                value={name}
                placeholder={n.hostname}
                maxLength={40}
                disabled={busy}
                onChange={(e) => setName(e.target.value)}
                onBlur={saveName}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
                }}
              />
              <span className={ASIDE}>What the pages call it; empty means the hostname.</span>
            </Stack>
          ),
        },
        {
          k: 'Keep awake',
          v: (
            <Stack>
              <span className="inline-flex items-center gap-3">
                <Switch
                  checked={awake}
                  disabled={busy || !approved}
                  onCheckedChange={(v) => save({ ...n.policy, awakeHold: v })}
                  aria-label="Keep awake"
                />
                <span className="text-[0.82rem]">{awake ? 'held awake' : 'may sleep'}</span>
              </span>
              <span className={ASIDE}>
                On, the agent holds a power request for as long as it runs and turns the plan's
                sleep timers off. Off releases the request; the plan is left as it is.
              </span>
            </Stack>
          ),
        },
        {
          k: 'Claude remote control',
          v: (
            <Stack>
              <span className="inline-flex flex-wrap items-center gap-3">
                <Switch
                  checked={claude}
                  disabled={busy || !approved}
                  onCheckedChange={(v) => save({ ...n.policy, claudeRemoteControl: v })}
                  aria-label="Claude remote control"
                />
                <span className="text-[0.82rem]">{claude ? 'runs' : 'off'}</span>
                {approved && claude && (
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={busy || n.claudeRestartRequested}
                    onClick={restartClaude}
                  >
                    {n.claudeRestartRequested ? 'Restart queued' : 'Restart now'}
                  </Button>
                )}
              </span>
              <span className={ASIDE}>
                The agent's tray runs <Mono>claude remote-control</Mono> in the user's session, with
                that user's Claude login, the way this box runs its own.
                {n.claude !== null &&
                  ` Now: ${n.claude.state}${n.claude.serverVersion !== null ? ` ${n.claude.serverVersion}` : ''}, ${String(n.claude.sessions)} session${n.claude.sessions === 1 ? '' : 's'}.`}
              </span>
            </Stack>
          ),
        },
      ]}
    >
      {!approved && (
        <p className={NOTE}>
          A policy is sent only to an approved machine. Approve it on{' '}
          <Link to="/c/$category" params={{ category: 'system' }} search={{ tab: 'machines' }}>
            System › Machines
          </Link>{' '}
          first; the switches above take effect on its next hello after that.
        </p>
      )}
      {error !== null && <p className={ERROR_NOTE}>{error}</p>}
    </Section>
  )
}

export function Machines({ rows }: { rows: NodeRow[] }) {
  return (
    <div className="flex flex-col gap-6">
      {rows.length === 0 ? (
        <Section
          title="Machines"
          icon={<MonitorSmartphoneIcon />}
          description="No machine has announced itself yet."
        >
          <p className={NOTE}>
            Install the agent on a machine and approve it on{' '}
            <Link to="/c/$category" params={{ category: 'system' }} search={{ tab: 'machines' }}>
              System › Machines
            </Link>
            ; it appears here with its policy once it has said hello.
          </p>
        </Section>
      ) : (
        rows.map((n) => <MachineSection key={n.id} n={n} />)
      )}
      <p className={NOTE}>
        Each switch reaches its machine on the agent's next hello, within a minute. What a machine
        is — its hardware, its agent, whether it answers — is on System › Machines, with the approve
        and revoke decisions.
      </p>
    </div>
  )
}
