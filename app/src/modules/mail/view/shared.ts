import type { Tone } from '../../../lib/tone'
import type { MailData } from '../data'
import type { AccountState, BridgeReport } from '../data/bridge'

// What the Email page's boards share: each tab's payload, and the words and
// tones Bridge's states and events are drawn with.

export type Relay = Extract<MailData, { tab: 'relay' }>
export type Proton = Extract<MailData, { tab: 'proton' }>

/** Connected is the norm and recedes; the other two are why you opened the page. */
export const ACCOUNT_STATE: Record<AccountState, { label: string; tone: Tone }> = {
  connected: { label: 'connected', tone: 'ok' },
  locked: { label: 'locked', tone: 'warn' },
  'signed-out': { label: 'signed out', tone: 'bad' },
}

/**
 * Each event the supervisor writes, as a row says it. Only the ones that mean
 * mail has stopped (or soon will) carry a tone; the rest are the ordinary
 * history of a running Bridge. A kind not listed is shown as written.
 */
export const EVENT: Record<string, { label: string; tone?: Tone }> = {
  'sync-started': { label: 'Sync started' },
  'sync-finished': { label: 'Sync finished' },
  online: { label: 'Back online' },
  offline: { label: 'Offline', tone: 'warn' },
  disconnected: { label: 'Account disconnected', tone: 'bad' },
  'imap-login-failed': { label: 'IMAP login refused', tone: 'warn' },
  'mailbox-read-failed': { label: 'Mailbox read failed', tone: 'warn' },
  'bad-event': { label: 'Bad event from Proton' },
  'update-required': { label: 'Update required', tone: 'bad' },
  'update-error': { label: 'Update check failed' },
  'mail-server-error': { label: 'Mail server error' },
  'no-keychain': { label: 'No keychain', tone: 'bad' },
  notification: { label: 'Notification' },
  error: { label: 'Error' },
}

/** Moving right now: worth asking again in seconds rather than half a minute. */
export function busy(r: BridgeReport): boolean {
  return (
    r.reporting &&
    r.status !== null &&
    (r.status.phase === 'starting' || r.status.users.some((u) => u.sync.state === 'syncing'))
  )
}

/** A unit as a row names it: without the `.service` every one of them carries. */
export const unitName = (unit: string): string => unit.replace(/\.service$/, '')
