import { Link, useRouter } from '@tanstack/react-router'
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
import { useHydrated } from '../lib/hydrated'
import { useSettled } from '../lib/settled'
import { isScheme, type Scheme, type ThemeChoice } from '../lib/theme'
import { saveTheme } from '../server/settings'
import { Bar, Disc } from './skeleton'
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
  MENU_ITEM,
  MENU_PANEL,
} from './ui/dropdown-menu'

// The foot of the rail: who is signed in, and the few things that are about
// that person rather than about the box — their profile (a page of its own,
// /profile), the settings, the theme, their passkeys, signing out. Settings
// lives here rather than on a rail row: it is reached rarely, and the corner
// of a control plane is where people look for themselves.
//
// The account arrives deferred (routes/__root.tsx) because it asks Pocket ID,
// and no page should wait on that to paint. Until it lands — and when it
// answers null — the button opens the same menu without the header.

const SCHEMES: { value: Scheme; label: string; icon: ReactNode }[] = [
  { value: 'light', label: 'Light', icon: <SunIcon /> },
  { value: 'dark', label: 'Dark', icon: <MoonIcon /> },
  { value: 'system', label: 'System', icon: <MonitorIcon /> },
]

type Props = {
  account: Promise<Account | null>
  theme: ThemeChoice
  /** Settings or Profile is open: the button lights like a rail row would. */
  active: boolean
  /** The rail's own row, label and active looks (shell/rail.tsx). */
  triggerClassName: string
  activeClassName: string
  labelClassName: string
}

export function AccountMenu({ account, ...rest }: Props) {
  // One <Menu>, whatever the promise is doing: a skeleton until Pocket ID
  // answers, then the account, remembered across navigations
  // (lib/settled.ts). `fetchAccount` never rejects: nobody signed in, or
  // Pocket ID failing, answers null and the menu opens without a header.
  const a = useSettled('account', account)
  // Before React has wired the page — the first load in dev mode is a few
  // hundred script requests — the server's button would be inert, and a
  // menu that will not open reads as broken. So until hydration the menu
  // is a native popover, which the browser opens with no script at all,
  // holding the rows that are plain links.
  if (!useHydrated()) return <NativeMenu {...rest} />
  return <Menu account={a ?? null} loading={a === undefined} {...rest} />
}

// Radix lights a row through its own attribute; a plain link lights on hover.
const NATIVE_ITEM = cn(MENU_ITEM, 'hover:bg-(--panel-2) hover:text-foreground')

function NativeMenu({
  active,
  triggerClassName,
  activeClassName,
  labelClassName,
}: Omit<Props, 'account' | 'theme'>) {
  return (
    <>
      <button
        type="button"
        aria-label="Account menu"
        popoverTarget="account-menu"
        className={cn(
          triggerClassName,
          'w-full cursor-pointer border-0 bg-transparent text-left',
          active && activeClassName,
        )}
      >
        <Disc size={22} />
        <span className={cn(labelClassName, 'flex flex-1 items-center')}>
          <Bar w="60%" h={11} />
        </span>
        <ChevronsUpDownIcon className="size-3.5 opacity-60 nav-collapsed:hidden" />
      </button>
      {/* In the top layer, so it sits over the page like the real one; the
          browser centres a popover by default, and this one belongs above
          its button at the rail's foot. */}
      <div
        id="account-menu"
        popover="auto"
        className={cn(MENU_PANEL, 'fixed inset-auto bottom-[3.6rem] left-[0.7rem] m-0 w-[15.5rem]')}
      >
        <a href="/profile" className={NATIVE_ITEM}>
          <UserIcon />
          Profile
        </a>
        <a href="/settings" className={NATIVE_ITEM}>
          <SettingsIcon />
          Settings
        </a>
        <a href="/logout" className={NATIVE_ITEM}>
          <LogOutIcon />
          Sign out
        </a>
      </div>
    </>
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
  loading,
  theme,
  active,
  triggerClassName,
  activeClassName,
  labelClassName,
}: Omit<Props, 'account'> & { account: Account | null; loading: boolean }) {
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
    // Non-modal: a rail menu has no business locking the page's scroll,
    // switching the body's pointer events off, or hiding the page from a
    // screen reader while it is open. Outside clicks still close it.
    <DropdownMenu modal={false}>
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
          {/* A skeleton while the account is on its way, never a stand-in
              name: the button still opens the menu. */}
          {loading ? <Disc size={22} /> : <Avatar account={account} size={22} />}
          <span className={cn(labelClassName, 'flex flex-1 items-center')}>
            {loading ? <Bar w="60%" h={11} /> : label}
          </span>
          <ChevronsUpDownIcon className="size-3.5 opacity-60 nav-collapsed:hidden" />
        </button>
      </DropdownMenuTrigger>

      <DropdownMenuContent side="top" align="start" className="w-[15.5rem]">
        {loading && (
          <>
            <DropdownMenuLabel className="flex items-center gap-2.5 py-2">
              <Disc size={34} />
              <span className="flex min-w-0 flex-1 flex-col gap-1.5">
                <Bar w="55%" h={11} />
                <Bar w="80%" h={9} />
              </span>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
          </>
        )}
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
            <Link to="/profile">
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
