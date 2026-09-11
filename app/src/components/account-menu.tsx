import { Await, Link, useRouter } from '@tanstack/react-router'
import {
  ChevronsUpDownIcon,
  ExternalLinkIcon,
  KeyRoundIcon,
  LogOutIcon,
  MonitorIcon,
  MoonIcon,
  SettingsIcon,
  SunIcon,
  UserIcon,
} from 'lucide-react'
import { type ReactNode, useTransition } from 'react'

import type { Account } from '../core/settings/types'
import { cn } from '../lib/cn'
import { isScheme, type Scheme, type ThemeChoice } from '../lib/theme'
import { saveTheme } from '../server/settings'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from './ui/dropdown-menu'

// The foot of the rail: who is signed in, and the few things that are about
// that person rather than about the box — their profile, the settings, the
// theme, their passkeys, signing out. Settings moved in here from a row of its
// own: it is reached far less often than it was taking up room, and the corner
// of a control plane is where people look for themselves.
//
// The account arrives deferred (routes/__root.tsx) because it asks Pocket ID,
// and no page should wait on that to paint. Until it lands — and under the
// gate, where nobody is signed in — the button opens the same menu without
// the header.

const SCHEMES: { value: Scheme; label: string; icon: ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <SunIcon /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon /> },
  { value: 'system', label: 'System', icon: <MonitorIcon /> },
]

type Props = {
  account: Promise<Account | null>
  theme: ThemeChoice
  /** The settings pages are open: the button lights like a rail row would. */
  active: boolean
  /** The rail's own row, label and active looks (routes/__root.tsx). */
  triggerClassName: string
  activeClassName: string
  labelClassName: string
}

export function AccountMenu({ account, ...rest }: Props) {
  return (
    <Await promise={account} fallback={<Menu account={null} {...rest} />}>
      {(a) => <Menu account={a} {...rest} />}
    </Await>
  )
}

function Avatar({ account, size }: { account: Account | null; size: number }) {
  if (account === null) return <UserIcon />
  return (
    <img
      src={`/api/profile-picture?v=${String(account.pictureVersion)}`}
      alt=""
      width={size}
      height={size}
      style={{ width: size, height: size }}
      className="flex-none rounded-full object-cover"
    />
  )
}

function Menu({
  account,
  theme,
  active,
  triggerClassName,
  activeClassName,
  labelClassName,
}: Omit<Props, 'account'> & { account: Account | null }) {
  const router = useRouter()
  const [, start] = useTransition()
  const pick = (scheme: Scheme) => {
    start(async () => {
      await saveTheme({ data: { presetId: theme.presetId, scheme } })
      await router.invalidate()
    })
  }
  const label = account?.name ?? 'Account'

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          aria-label="Account menu"
          data-label={label}
          className={cn(
            triggerClassName,
            'w-full cursor-pointer border-0 bg-transparent text-left',
            active && activeClassName,
          )}
        >
          <Avatar account={account} size={22} />
          <span className={cn(labelClassName, 'flex-1')}>{label}</span>
          <ChevronsUpDownIcon className="size-3.5 opacity-60 nav-collapsed:hidden" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="w-[15.5rem]">
        {account !== null && (
          <>
            <DropdownMenuLabel className="flex items-center gap-2.5 py-2">
              <Avatar account={account} size={34} />
              <span className="min-w-0">
                <span className="block truncate font-[550] text-[0.86rem] text-foreground">
                  {account.name}
                </span>
                <span className="block truncate text-(--dim) text-[0.74rem]">
                  {account.email || account.username}
                </span>
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}

        <DropdownMenuGroup>
          <DropdownMenuItem asChild>
            <Link to="/settings" search={{ tab: 'profile' }}>
              <UserIcon />
              Profile
            </Link>
          </DropdownMenuItem>
          <DropdownMenuItem asChild>
            <Link to="/settings" search={{}}>
              <SettingsIcon />
              Settings
            </Link>
          </DropdownMenuItem>
        </DropdownMenuGroup>

        <DropdownMenuSeparator />
        <DropdownMenuLabel className="pt-1 pb-0.5 text-(--dim) text-[0.7rem] uppercase tracking-[0.08em]">
          Theme
        </DropdownMenuLabel>
        <DropdownMenuRadioGroup
          value={theme.scheme}
          onValueChange={(v) => {
            if (isScheme(v)) pick(v)
          }}
        >
          {SCHEMES.map((s) => (
            <DropdownMenuRadioItem
              key={s.value}
              value={s.value}
              // Stays open, so the change can be seen before choosing again.
              onSelect={(e) => {
                e.preventDefault()
              }}
            >
              {s.icon}
              {s.label}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>

        <DropdownMenuSeparator />
        {account !== null && account.accountUrl !== '' && (
          <DropdownMenuItem asChild>
            <a href={account.accountUrl} target="_blank" rel="noreferrer">
              <KeyRoundIcon />
              Passkeys
              <ExternalLinkIcon className="ml-auto" />
            </a>
          </DropdownMenuItem>
        )}
        {/* A full page load, not a router link: /logout is answered by the
            forward-auth middleware in front of this app, which ends the
            Pocket ID session and comes back through its callback. */}
        <DropdownMenuItem asChild>
          <a href="/logout">
            <LogOutIcon />
            Sign out
          </a>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
