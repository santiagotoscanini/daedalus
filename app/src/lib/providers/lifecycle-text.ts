import type { ProviderInstall } from '../../host/controller/generated'

// How AI › Providers words a machine's Lemonade install and process, from what
// its agent reported (modules/ai/view/providers/lifecycle.tsx). Pure, so the
// cases that once contradicted the header are pinned by tests: an agent that
// predates install and power reports those fields empty, and a server running
// without a pid the agent could name (macOS's root daemon) is still running.

const METHOD: Record<ProviderInstall['method'], string> = {
  msi: 'MSI',
  pkg: 'macOS package',
  deb: '.deb package',
  rpm: '.rpm package',
}

/** What the page knows of the machine for these lines. */
export type LifecycleFacts = {
  /** The agent speaks install and power; null without a hello. */
  speaks: boolean | null
  /** The agent reported this provider at all (running or installed). */
  present: boolean
  running: boolean
  install: ProviderInstall | null | undefined
  pid: number | null | undefined
  session: number | null | undefined
  owner: string | null | undefined
}

export type Worded = { text: string; tone: 'warn' | null }

/** The install line: how it was installed and for whom, or why that is not known. */
export function installText(f: LifecycleFacts): Worded {
  if (!f.present) return { text: 'none', tone: null }
  if (f.speaks === false) return { text: 'not reported — its agent is too old', tone: 'warn' }
  if (f.speaks === null) return { text: 'unknown — its agent has not said hello', tone: null }
  const i = f.install
  if (i == null) return { text: 'not one the agent can manage', tone: 'warn' }
  const scope =
    i.scope === 'machine' ? 'per machine' : `per user${i.user === null ? '' : ` (${i.user})`}`
  return { text: `${METHOD[i.method]} · ${scope}`, tone: null }
}

/** The process line: its pid, session and owner, or as much as is known. */
export function processText(f: LifecycleFacts): string {
  if (f.pid != null) {
    return [
      `pid ${String(f.pid)}`,
      ...(f.session == null ? [] : [`session ${String(f.session)}`]),
      ...(f.owner == null ? [] : [f.owner]),
    ].join(' · ')
  }
  if (f.running) return 'running · pid not reported'
  if (!f.present) return 'none'
  return 'not running'
}

/** The uninstall-by-hand notice belongs only to an agent that looked and found no record. */
export const unmanagedInstall = (f: LifecycleFacts): boolean =>
  f.present && f.speaks === true && f.install == null
