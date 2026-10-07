import { useSearch } from '@tanstack/react-router'
import type { MachinesData } from '../../../lib/dashboard/machines'
import { Ago } from '../../ago'
import { BoxProvider, GatewaySync } from '../provider-models'
import { ASIDE, Band, Mono, NOTE_SHOWN, SECTIONS, Section } from '../shared'
import { Install } from './install'
import { BACK } from './machine-cells'
import { MachineRow, MachinesHead, PendingRow } from './machine-section'
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
// This file is the tab: the machine table (./machine-section.tsx, its cells ./machine-cells.tsx); the trust buttons are
// ./decision.tsx, the policy rows ./policy.tsx over ./use-policy-editor.ts,
// the install lines ./install.tsx, the controller's key rotation ./rotate.tsx, the
// session host's line ./session-host.tsx.

export function Machines({ d }: { d: MachinesData }) {
  // A machine's own "santree on the box" opens this page at
  // `?tab=machines&node=<id>&santree=on` (agent settings.rs `confirm_url`).
  const search = useSearch({ from: '/settings' })
  const c = d.controller
  const sync = d.sync
  const waiting = d.machines.filter((m) => m.node === null).length
  return (
    <div className={SECTIONS}>
      <Section
        title="Machines"
        description="The other computers that run the agent: what each one is, whether the box trusts it, and what it asks of them. Open one for its whole story."
        aside={
          d.machines.length === 0 ? undefined : (
            <>
              {String(d.machines.length)} machine{d.machines.length === 1 ? '' : 's'}
              {waiting > 0 && ` · ${String(waiting)} waiting`}
            </>
          )
        }
        body={
          d.machines.length === 0 ? (
            <Band>
              <p className={NOTE_SHOWN}>
                {d.listError !== null
                  ? `The controller's list could not be read: ${d.listError}`
                  : 'No machine has joined yet. Install the agent on a machine with a line below and it appears here, waiting for you to approve it.'}
              </p>
            </Band>
          ) : (
            <ul className="m-0 list-none p-0">
              <MachinesHead />
              {d.machines.map((m) =>
                m.node === null ? (
                  <PendingRow
                    key={m.pending?.id ?? ''}
                    m={m}
                    controllerFingerprint={c.reachable ? c.fingerprint : null}
                  />
                ) : (
                  <MachineRow
                    key={m.node.id}
                    m={m}
                    lanDomain={d.lanDomain}
                    open={search.node === m.node.id || d.machines.length === 1}
                    askSantree={search.santree === 'on' && search.node === m.node.id}
                  />
                ),
              )}
            </ul>
          )
        }
      />

      <Section
        title="The controller"
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
        description="What every provider above offers becomes a route in LiteLLM, kept in step by the box."
        rows={[
          { k: 'This box', v: <BoxProvider /> },
          { k: 'Sync', v: <GatewaySync /> },
        ]}
      />

      <Section
        title="How a machine joins"
        description="One line per system, carrying this box's controller and the key to pin."
        body={<Install controller={c} />}
      />
    </div>
  )
}
