import { useEffect, useState } from 'react'
import type { RailBadges } from '../../lib/rail-badge'
import { fetchRailBadgesFn } from '../../server/shell'
import { usePoll } from '../poll'

// The rail's dots, asked once the shell has mounted and then every minute.
// The shell outlives every navigation, so a page change neither re-asks nor
// redraws them; nothing is drawn until the first answer, so there is no
// loading state to flash, and a read that fails keeps the last answer.

const POLL_MS = 60_000

const read = (set: (b: RailBadges) => void) => fetchRailBadgesFn().then(set, () => undefined)

export function useRailBadges(): RailBadges {
  const [badges, setBadges] = useState<RailBadges>({})
  useEffect(() => {
    void read(setBadges)
  }, [])
  usePoll(() => read(setBadges), POLL_MS, true)
  return badges
}
