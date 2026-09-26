import { LogBoard } from '../../../components/logs'
import { Changelog } from '../../../components/release-notes'
import { compareOf, Open, ServiceHead, verdictOf } from '../../../components/service-head'
import { FOOT, NOTE, SUB } from '../../../components/tokens'
import { BarList, Board, BoardGrid, Chip, Facts, Measures, Pulse } from '../../../components/viz'
import { DASH, num } from '../../../lib/format'
import type { HomeData } from '../data'

// Home › House: Home Assistant — who is home, what is on, what has stopped
// answering, and where the instance believes it is.

/* One person, as a pill. The border is supplied by the caller either way —
   "home" tints it, and a second border utility layered over a first would be
   decided by the stylesheet's order rather than by the string's. */
const PERSON =
  'flex items-center gap-[0.4rem] rounded-full border bg-(--panel-2) px-[0.6rem] py-[0.3rem] text-[0.82rem] [&>em]:text-[0.72rem] [&>em]:not-italic [&>em]:text-(--dim)'
const TEMP =
  'flex max-w-[11rem] min-w-0 flex-col items-start rounded-[8px] bg-(--panel-2) px-[0.6rem] py-[0.35rem] [&>strong]:text-[1.05rem] [&>strong]:font-semibold [&>strong]:tabular-nums [&>em]:max-w-full [&>em]:truncate [&>em]:text-[0.67rem] [&>em]:not-italic [&>em]:text-(--dim)'

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
            The automation hub, and the only container on this box in the host network namespace.
            mDNS and SSDP discovery do not cross a bridge, so every IoT integration would otherwise
            need hand-typed addresses.
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
              <span className="text-[0.73rem] text-danger">not answering</span>
            )
          }
        >
          {d.people.length > 0 && (
            <ul className="flex list-none flex-row flex-wrap gap-[0.4rem]">
              {d.people.map((p) => (
                <li
                  key={p.name}
                  className={`${PERSON} ${p.home ? 'border-success/35' : 'border-(--border-soft)'}`}
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
              { k: 'people home', v: d.reachable ? num(homeCount) : DASH },
              { k: 'lights on', v: `${num(d.lightsOn)} / ${num(d.lightsTotal)}` },
              { k: 'switches on', v: num(d.switchesOn) },
              { k: 'automations on', v: `${num(d.automations.on)} / ${num(d.automations.total)}` },
            ]}
          />

          {d.temperatures.length > 0 && (
            <>
              <h4 className={SUB}>Temperature</h4>
              <div className="flex flex-wrap gap-[0.5rem]">
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
          {/* Split by domain rather than counted. The count is never zero and
              never will be — 25 Tuya bulbs have been unavailable since they
              lost their WiFi pairing — so the only reading worth having is
              whether the set has grown somewhere NEW. */}
          <BarList items={d.unavailableBy} tone="warn" empty="every entity is reporting" />
          <p className={FOOT}>
            {num(d.unavailable)} of {num(d.entities)} entities are <b>unavailable</b> or{' '}
            <b>unknown</b>. Most of that is the Tuya lights, which have been off the network since
            they lost their pairing and need re-pairing from the app. That number will not fall on
            its own. A domain appearing here that did not before is the thing to notice.
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
              note: 'The host system bus rejects a connection from container root, so this relay passes the socket through with the uid rewritten. It has to forward SCM_RIGHTS as well, which is why a plain xdg-dbus-proxy does not work. Bluetooth integrations going quiet after a reboot is this unit not having come up. Defined in platform/bluetooth.',
            },
          ]}
        />
      </BoardGrid>
    </>
  )
}
