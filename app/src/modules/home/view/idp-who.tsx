// Home › Sign-in: who has an account and which groups they are in, and the
// devices that hold a key to the house.

import {
  BOARD_TABLE,
  BOARD_TABLE_HEAD,
  BOARD_TABLE_ROW,
  NUM_CELL,
} from '../../../components/modules/parts'
import { CELL_QUIET } from '../../../components/table'
import { CAPTION, EMPTY, FOOT } from '../../../components/tokens'
import { Board, Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { IdpData } from '../data/signin'
import { COUNT } from './idp-apps'

/* A name and one reading beside it: the shape of all three small tables. */
const PAIR = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-5'
/* The devices add a count. */
const TRIPLE = 'grid grid-cols-[minmax(0,1fr)_auto_3rem] items-center gap-x-4 px-5'
/* The rows of a quarter-width board: the house row, a little shorter. */
const ROW = cn(BOARD_TABLE_ROW, 'min-h-11')
const NAME = 'flex min-w-0 items-center gap-2 text-[0.84rem] text-foreground'

export function WhoBoard({ d }: { d: IdpData }) {
  return (
    <Board title="Who" icon="◑" span={4}>
      <ul className={BOARD_TABLE}>
        <li className={cn(PAIR, BOARD_TABLE_HEAD)}>
          <span>Account</span>
          <span className={NUM_CELL}>Last sign-in</span>
        </li>
        {d.users.map((u) => (
          <li key={u.username} className={cn(PAIR, ROW)} title={u.groups.join(', ')}>
            <span className={NAME}>
              <span className="truncate">{u.displayName === '' ? u.username : u.displayName}</span>
              {u.admin && <span className="text-[0.75rem] text-muted-foreground">admin</span>}
              {u.disabled && <Chip tone="bad">disabled</Chip>}
              {/* An admin account that is not a person, and the only place
                  on this dashboard it is visible at all. */}
              {u.service && (
                <Chip
                  tone="muted"
                  title="The principal behind STATIC_API_KEY, how daedalus reads this page"
                >
                  api key
                </Chip>
              )}
            </span>
            <span className={cn(CELL_QUIET, 'text-right whitespace-nowrap')}>
              {u.service ? 'never signs in' : (u.lastSignInAgo ?? 'not in the window')}
            </span>
          </li>
        ))}
      </ul>

      <ul className={BOARD_TABLE}>
        <li className={cn(PAIR, BOARD_TABLE_HEAD)}>
          <span>Group</span>
          <span className={NUM_CELL}>Members</span>
        </li>
        {d.groups.map((g) => (
          <li key={g.name} className={cn(PAIR, ROW)}>
            <span className={cn(NAME, 'truncate')}>{g.name}</span>
            <span className={cn(CELL_QUIET, 'text-right')}>
              {g.members === 0 ? 'nobody in it' : num(g.members)}
            </span>
          </li>
        ))}
      </ul>

      <p className={CAPTION}>
        Sign-ups are <b>{d.signups ?? 'unknown'}</b>, read back from the IdP rather than restated
        here.
      </p>
      <p className={FOOT}>
        A group is what an application restricts itself to, so an empty one is an application nobody
        can reach through it.
      </p>
    </Board>
  )
}

/** Grouped, not listed — see `IdpData['devices']`. */
export function DevicesBoard({ d }: { d: IdpData }) {
  return (
    <Board title="Devices that signed in" icon="key" span={4}>
      {d.devices.length === 0 ? (
        <p className={EMPTY}>nobody signed in during the window</p>
      ) : (
        <ul className={BOARD_TABLE}>
          <li className={cn(TRIPLE, BOARD_TABLE_HEAD)}>
            <span>Device</span>
            <span className={NUM_CELL}>Last</span>
            <span className={NUM_CELL}>Uses</span>
          </li>
          {d.devices.map((v) => (
            <li key={v.name} className={cn(TRIPLE, ROW)}>
              <span className={cn(NAME, 'truncate')} title={v.name}>
                {v.name}
              </span>
              <span className={cn(CELL_QUIET, 'text-right whitespace-nowrap')}>{v.lastAgo}</span>
              <span className={COUNT}>{num(v.signIns)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        A passkey belongs to a device, so the devices are the credentials. One you do not recognise
        is the thing to notice here.
      </p>
    </Board>
  )
}
