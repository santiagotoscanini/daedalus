// Home › Sign-in: who has an account, which groups exist, and the devices that
// hold a key to the house — three small tables in one row.

import { NUM_CELL, SECTION_SPAN, TABLE_NONE } from '../../../components/modules/parts'
import { CELL_QUIET, TABLE, TABLE_HEAD, TABLE_ROW } from '../../../components/table'
import { TableSection } from '../../../components/table-section'
import { CAPTION, FOOT } from '../../../components/tokens'
import { Chip } from '../../../components/viz'
import { cn } from '../../../lib/cn'
import { num } from '../../../lib/format'
import type { IdpData } from '../data/signin'
import { COUNT } from './idp-apps'

/* A name and one reading beside it: the shape of the two small tables. */
const PAIR = 'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 px-5'
/* The devices add a count. */
const TRIPLE = 'grid grid-cols-[minmax(0,1fr)_auto_3rem] items-center gap-x-4 px-5'
const NAME = 'flex min-w-0 items-center gap-2 text-[0.84rem] text-foreground'

export function AccountsSection({ d }: { d: IdpData }) {
  return (
    <TableSection title="Accounts" className={SECTION_SPAN[4]}>
      <ul className={TABLE}>
        <li className={cn(PAIR, TABLE_HEAD)}>
          <span>Account</span>
          <span className={NUM_CELL}>Last sign-in</span>
        </li>
        {d.users.map((u) => (
          <li key={u.username} className={cn(PAIR, TABLE_ROW)} title={u.groups.join(', ')}>
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
            <span className={cn(CELL_QUIET, NUM_CELL)}>
              {u.service ? 'never signs in' : (u.lastSignInAgo ?? 'not in the window')}
            </span>
          </li>
        ))}
      </ul>
      <p className={CAPTION}>
        Sign-ups are <b>{d.signups ?? 'unknown'}</b>, read back from the IdP rather than restated
        here.
      </p>
    </TableSection>
  )
}

export function GroupsSection({ d }: { d: IdpData }) {
  return (
    <TableSection title="Groups" className={SECTION_SPAN[4]}>
      {d.groups.length === 0 ? (
        <p className={TABLE_NONE}>no groups</p>
      ) : (
        <ul className={TABLE}>
          <li className={cn(PAIR, TABLE_HEAD)}>
            <span>Group</span>
            <span className={NUM_CELL}>Members</span>
          </li>
          {d.groups.map((g) => (
            <li key={g.name} className={cn(PAIR, TABLE_ROW)}>
              <span className={cn(NAME, 'truncate')}>{g.name}</span>
              <span className={cn(CELL_QUIET, NUM_CELL)}>
                {g.members === 0 ? 'nobody in it' : num(g.members)}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        A group is what an application restricts itself to, so an empty one is an application nobody
        can reach through it.
      </p>
    </TableSection>
  )
}

/** Grouped, not listed — see `IdpData['devices']`. */
export function DevicesSection({ d }: { d: IdpData }) {
  return (
    <TableSection title="Devices that signed in" className={SECTION_SPAN[4]}>
      {d.devices.length === 0 ? (
        <p className={TABLE_NONE}>nobody signed in during the window</p>
      ) : (
        <ul className={TABLE}>
          <li className={cn(TRIPLE, TABLE_HEAD)}>
            <span>Device</span>
            <span className={NUM_CELL}>Last</span>
            <span className={NUM_CELL}>Uses</span>
          </li>
          {d.devices.map((v) => (
            <li key={v.name} className={cn(TRIPLE, TABLE_ROW)}>
              <span className={cn(NAME, 'truncate')} title={v.name}>
                {v.name}
              </span>
              <span className={cn(CELL_QUIET, NUM_CELL)}>{v.lastAgo}</span>
              <span className={COUNT}>{num(v.signIns)}</span>
            </li>
          ))}
        </ul>
      )}
      <p className={FOOT}>
        A passkey belongs to a device, so the devices are the credentials. One you do not recognise
        is the thing to notice here.
      </p>
    </TableSection>
  )
}
