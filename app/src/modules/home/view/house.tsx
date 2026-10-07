import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { CAPTION, FOOT, NOTE, SUB } from '../../../components/tokens'
import { BarList, Board, BoardGrid, Chip, Facts, Measures, Pulse } from '../../../components/viz'
import { DASH, num } from '../../../lib/format'
import type { HomeData } from '../data'

// Home › House: Home Assistant — who is home, what is on, what has stopped
// answering, and where the instance believes it is.

/* One person, as a pill. The border is supplied by the caller either way —
   "home" tints it, and a second border utility layered over a first would be
   decided by the stylesheet's order rather than by the string's. */
const PERSON =
  'flex items-center gap-1.5 rounded-full border bg-foreground/[0.03] px-2.5 py-1 text-[0.8rem] [&>em]:text-[0.75rem] [&>em]:not-italic [&>em]:text-muted-foreground'
const TEMP =
  'flex max-w-[11rem] min-w-0 flex-col items-start gap-0.5 rounded-xl border border-hairline bg-foreground/[0.03] px-3 py-2 [&>strong]:text-[1.1rem] [&>strong]:tracking-tight [&>strong]:[font-weight:560] [&>strong]:tabular-nums [&>em]:max-w-full [&>em]:truncate [&>em]:text-[0.72rem] [&>em]:not-italic [&>em]:text-muted-foreground'

type House = Extract<HomeData, { tab: 'house' }>

export function HouseView({ data: d }: { data: House }) {
  const homeCount = d.people.filter((p) => p.home).length

  return (
    <>
      <ServiceHead
        logo="/icon-home-assistant.png"
        name="Home Assistant"
        version={d.version}
        versionNote="reported by the running process"
        verdict={verdictOf(d.gap)}
        compare={compareOf(d.gap, 'from /api/config — what it says about itself')}
        lede={
          <>
            The automation hub, and the only container here in the host network namespace: mDNS and
            SSDP discovery do not cross a bridge, so integrations would need hand-typed addresses.
          </>
        }
        actions={<Open name="Home Assistant" host="homeassistant" />}
      />

      <BoardGrid>
        <Board
          title="The house"
          icon="⌂"
          span={8}
          aside={
            d.reachable ? (
              <span className={NOTE}>
                {num(d.entities)} entities · {num(d.integrations)} integrations
              </span>
            ) : (
              <span className="text-[0.75rem] text-danger">not answering</span>
            )
          }
        >
          {d.people.length > 0 && (
            <ul className="m-0 flex list-none flex-row flex-wrap gap-1.5 p-0">
              {d.people.map((p) => (
                <li
                  key={p.name}
                  className={`${PERSON} ${p.home ? 'border-success/35' : 'border-hairline'}`}
                >
                  <Pulse on={p.home} tone="ok" />
                  <span>{p.name}</span>
                  <em>{p.home ? 'home' : 'away'}</em>
                </li>
              ))}
            </ul>
          )}

          <Measures
            items={[
              { k: 'People home', v: d.reachable ? num(homeCount) : DASH },
              { k: 'Lights on', v: `${num(d.lightsOn)} / ${num(d.lightsTotal)}` },
              { k: 'Switches on', v: num(d.switchesOn) },
              { k: 'Automations on', v: `${num(d.automations.on)} / ${num(d.automations.total)}` },
            ]}
          />

          {d.temperatures.length > 0 && (
            <>
              <h4 className={SUB}>Temperature</h4>
              <div className="flex flex-wrap gap-2">
                {d.temperatures.map((t) => (
                  <span key={t.label} className={TEMP}>
                    <strong>{t.value.toFixed(1)}°</strong>
                    <em title={t.label}>{t.label}</em>
                  </span>
                ))}
              </div>
            </>
          )}

          <h4 className={SUB}>Entities by domain</h4>
          <BarList items={d.domains} tone="info" empty="nothing to count" />
        </Board>

        <Board title="Not answering" icon="warn" span={4}>
          {/* Split by domain rather than counted — see `unavailableBy`. */}
          <BarList items={d.unavailableBy} tone="warn" empty="every entity is reporting" />
          <p className={CAPTION}>
            {num(d.unavailable)} of {num(d.entities)} entities are <b>unavailable</b> or{' '}
            <b>unknown</b>.
          </p>
          <p className={FOOT}>
            Most of that is the Tuya lights, which have been off the network since they lost their
            pairing and need re-pairing from the app. That number will not fall on its own. A domain
            appearing here that did not before is the thing to notice.
          </p>
        </Board>

        <Board title="Where" icon="◉" span={4}>
          <Facts
            rows={[
              { k: 'Location', v: d.place.name ?? DASH },
              { k: 'Country', v: d.place.country ?? DASH },
              { k: 'Time zone', v: d.place.timeZone ?? DASH },
              {
                k: 'State',
                v:
                  d.place.state === null ? (
                    DASH
                  ) : d.place.state === 'RUNNING' ? (
                    <Chip tone="ok">running</Chip>
                  ) : (
                    <Chip tone="warn">{d.place.state.toLowerCase()}</Chip>
                  ),
              },
            ]}
          />
          <p className={FOOT}>
            Read back from the instance rather than restated here. A time zone that has drifted from
            the host&rsquo;s is what makes an automation fire an hour late.
          </p>
        </Board>

        <Changelog gap={d.gap} span={8} />

        <LogBoard
          source={{ container: 'home-assistant' }}
          title="Home Assistant logs"
          neighbours={[
            {
              source: { unit: 'ha-dbus-relay.service' },
              label: 'D-Bus relay',
              role: 'how it reaches the Bluetooth adapter',
              note: 'The host system bus rejects a connection from container root, so this relay passes the socket through with the uid rewritten. It has to forward SCM_RIGHTS as well, which is why a plain xdg-dbus-proxy does not work. Bluetooth integrations going quiet after a reboot is this unit not having come up. Defined in the host configuration, not the engine.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}
