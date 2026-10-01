import { BoardGrid } from '../../../components/viz'
import type { NetworkData } from '../data'
import {
  MySpeedLogsBoard,
  TheLineItselfBoard,
  TheRouterBoard,
  TheWayOutBoard,
  WhatCrossesTheCableBoard,
  WhatThisHouseAsksForBoard,
  WhichServicesMoveTheBytesBoard,
} from './general-boards'

export type General = Extract<NetworkData, { tab: 'general' }>

/**
 * The house network: the cable, the line behind it, and who is using both.
 *
 * The NIC counters (USAGE) and the speed test (CAPACITY) are two boards, never
 * one chart with two lines on it — neither bounds the other; `GeneralData`
 * says why.
 */
export function GeneralView({ data }: { data: General }) {
  const f = generalFacts({ data })

  return (
    <>
      {/* No headline band. Every figure one would have carried is the lead
          reading of a board below it — the two rates head the chart they are
          drawn from, the round trip sits with the probe that measured it, the
          device count is the panel's own aside. Four cards restating them
          would be the same numbers twice, one scroll apart. */}
      <BoardGrid>
        <WhatCrossesTheCableBoard f={f} />

        <TheWayOutBoard f={f} />

        <TheRouterBoard f={f} />

        <WhichServicesMoveTheBytesBoard f={f} />

        <TheLineItselfBoard f={f} />

        <WhatThisHouseAsksForBoard f={f} />

        {/* No device list here: what is on the LAN is a lease fact, not a
            throughput one, so it lives on the DHCP tab. */}

        {/* The wire keeps no log, but the three processes that MEASURE it do,
            and every reading above comes from one of them. MySpeed leads
            because it is the only one that is a service rather than plumbing,
            and the only one whose failure shows as a wrong number rather than
            a missing one. */}
        <MySpeedLogsBoard />
      </BoardGrid>
    </>
  )
}

/** What the page's boards read. */
function generalFacts({ data }: { data: General }) {
  const { wire, line, hops, router, services, dns } = data

  const gateway = hops.find((h) => h.id === 'gateway')
  const internet = hops.find((h) => h.id === 'internet')
  const moved = services.reduce((n, s) => n + s.in + s.out, 0)
  return { data, wire, line, hops, router, services, dns, gateway, internet, moved }
}

export type GeneralFacts = NonNullable<ReturnType<typeof generalFacts>>
