import { useSearch } from '@tanstack/react-router'
import { MonitorSmartphoneIcon, NetworkIcon } from 'lucide-react'

import type { MachinesData } from '../../../lib/dashboard/machines'
import { Ago } from '../../ago'
import { NOTE_SHOWN } from '../form'
import { BoxProvider, GatewaySync } from '../provider-models'
import { ASIDE, Mono, Rows, Section } from '../shared'
import { Install } from './install'
import { BACK, MachineSection, PendingSection } from './machine-section'
import { RotateKey, RotationState } from './rotate'
import { SessionHost } from './session-host'

// Settings › Machines — the other computers that run the agent: what each
// one is, whether the box trusts it, and what the box asks of it. One card
// per machine, and the whole story on it: the decision about a machine and
// the policy sent to it are read together, so they sit together.
//
// Every machine keeps one link to the controller — the agent on this box —
// and the page reads them all from it (lib/dashboard/machines.ts). A key
// that connected and waits has a card with both fingerprints: the machine's,
// which its tray shows beside the controller's, and the controller's, so the
// two can be compared before approving. An approved machine's card carries
// its policy; a machine that is not connected shows what the box last knew.
//
// The second kind of setting on this page: Postgres, not site/. A decision
// or a policy reaches the controller as the desired set the moment it is
// saved, and a connected machine hears it at once — so each row saves on
// click, like Appearance, with no Apply bar. The policy rows appear only
// once a machine is approved: the box sends no policy to a key it has not.
//
// This file is the tab and one card per machine; the trust buttons are
// ./decision.tsx, the policy rows ./policy.tsx over ./use-policy-editor.ts,
// the install lines ./install.tsx, the controller's key rotation ./rotate.tsx, the
// session host's line ./session-host.tsx.

export function Machines({ d }: { d: MachinesData }) {
  // A machine's own "santree on the box" opens this page at
  // `?tab=machines&node=<id>&santree=on` (agent settings.rs `confirm_url`).
  const search = useSearch({ from: '/settings' })
  const c = d.controller
  const sync = d.sync
  return (
    <div className="flex flex-col gap-5">
      {d.machines.length === 0 ? (
        <Section
          title="Machines"
          icon={<MonitorSmartphoneIcon />}
          description="No machine has joined yet."
        >
          <p className={NOTE_SHOWN}>
            {d.listError !== null
              ? `The controller's list could not be read: ${d.listError}`
              : 'Install the agent on a machine with a line below and it appears here, waiting for you to approve it.'}
          </p>
        </Section>
      ) : (
        d.machines.map((m) =>
          m.node === null ? (
            <PendingSection
              key={m.pending?.id ?? ''}
              m={m}
              controllerFingerprint={c.reachable ? c.fingerprint : null}
            />
          ) : (
            <MachineSection
              key={m.node.id}
              m={m}
              lanDomain={d.lanDomain}
              askSantree={search.santree === 'on' && search.node === m.node.id}
            />
          ),
        )
      )}

      <Section
        title="The controller"
        icon={<NetworkIcon />}
        description="The agent on this box: every machine keeps one link to it, and this page reads them all through it."
        rows={
          c.reachable
            ? [
                {
                  k: 'Machines dial',
                  v:
                    c.address === null ? (
                      <span className={ASIDE}>no listener</span>
                    ) : (
                      <Mono>{c.address}</Mono>
                    ),
                },
                { k: 'Its key', v: <Mono>{c.fingerprint}</Mono> },
                ...(c.rotation !== null
                  ? [{ k: 'Rotating', v: <RotationState r={c.rotation} /> }]
                  : []),
                { k: 'Agent', v: <Mono>{c.version}</Mono> },
                ...(d.sessionHost !== null
                  ? [{ k: 'Session host', v: <SessionHost line={d.sessionHost} /> }]
                  : []),
                {
                  k: 'Decisions',
                  v:
                    sync === null ? (
                      <span className={ASIDE}>not sent since this process started</span>
                    ) : sync.error !== null ? (
                      <span className="inline-flex flex-col items-start gap-1">
                        <span className="text-[0.78rem] text-destructive">
                          not delivered <Ago at={sync.at} />: {sync.error}
                        </span>
                        <span className={ASIDE}>{BACK}</span>
                      </span>
                    ) : (
                      <span className={ASIDE}>
                        {String(sync.sent.length)} key{sync.sent.length === 1 ? '' : 's'} handed
                        over <Ago at={sync.at} />
                        {sync.skipped.length > 0 && ` · ${String(sync.skipped.length)} left out`}
                      </span>
                    ),
                },
              ]
            : [
                {
                  k: 'State',
                  v: (
                    <span className="inline-flex flex-col items-start gap-1">
                      <span className="text-[0.78rem] text-destructive">
                        not reachable: {c.error}
                      </span>
                      <span className={ASIDE}>{BACK}</span>
                    </span>
                  ),
                },
              ]
        }
      >
        {c.reachable && <RotateKey rotating={c.rotation !== null} />}
      </Section>

      <Section
        title="The gateway"
        icon={<MonitorSmartphoneIcon />}
        description="What every provider above offers becomes a route in LiteLLM, kept in step by the box."
      >
        <Rows
          rows={[
            { k: 'This box', v: <BoxProvider /> },
            { k: 'Sync', v: <GatewaySync /> },
          ]}
        />
      </Section>

      <Section title="How a machine joins" icon={<MonitorSmartphoneIcon />}>
        <Install controller={c} />
      </Section>
    </div>
  )
}
