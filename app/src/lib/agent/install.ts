// The agent's install one-liners, naming the controller and pinning its key,
// and the `pair` line for a machine installed without them (agent/README.md
// "Install"). The scripts are the engine's, served by its public site from
// `main`, so no line names a version; where the machine connects and which
// key it trusts are this box's, read from the controller (`system.info`),
// never written here.
//
// Pure, for Settings › Machines: the page draws the lines and a copy button.

/** Where the engine's site serves agent/install.ps1 and agent/install.sh. */
const INSTALL_SITE = 'https://daedalus.toscanini.me'

/** Where install.ps1 puts the agent; Windows has it on no PATH. */
const WINDOWS_EXE = '"$env:ProgramFiles\\daedalus-agent\\daedalus-agent.exe"'

export type InstallOs = 'windows' | 'macos' | 'linux'

export type InstallLine = {
  os: InstallOs
  label: string
  /** Where to paste it. */
  where: string
  command: string
}

/** A POSIX shell word: single quotes, a quote inside closed, escaped and reopened. */
export function shQuote(s: string): string {
  return `'${s.replaceAll("'", `'\\''`)}'`
}

/** A PowerShell literal string: single quotes, a quote inside doubled. */
export function psQuote(s: string): string {
  return `'${s.replaceAll("'", "''")}'`
}

type Controller = { address: string; fingerprint: string }

const WINDOWS = { os: 'windows', label: 'Windows', where: 'an administrator PowerShell' } as const
const MACOS = {
  os: 'macos',
  label: 'macOS',
  where: 'Terminal, as the user whose Claude runs there',
} as const
const LINUX = {
  os: 'linux',
  label: 'Linux',
  where: 'a terminal (systemd 240 or newer, x86_64 or aarch64)',
} as const

/**
 * The three install lines. Windows and Linux carry `--controller` and `--pin`
 * (`-Controller`, `-Pin`): the machine is paired as it installs, dials that
 * address and trusts only that key. A Mac takes neither (install.sh refuses
 * them there): it logs in from its menu bar afterwards, and its log-in pins
 * the controller. Without the controller's answer there is no key to give,
 * and no line is returned.
 */
export function installLines(controller: Controller | null): InstallLine[] {
  if (controller === null) return []
  const unix = `curl -fsSL ${INSTALL_SITE}/install.sh | sudo sh -s -- --controller ${shQuote(controller.address)} --pin ${shQuote(controller.fingerprint)}`
  // A script block takes parameters where `irm … | iex` cannot; the
  // execution policy line is the README's, joined so it pastes as one.
  const windows = `Set-ExecutionPolicy -Scope Process Bypass -Force; & ([scriptblock]::Create((irm ${INSTALL_SITE}/install.ps1))) -Controller ${psQuote(controller.address)} -Pin ${psQuote(controller.fingerprint)}`
  return [
    { ...WINDOWS, command: windows },
    { ...MACOS, command: `curl -fsSL ${INSTALL_SITE}/install.sh | sudo sh` },
    { ...LINUX, command: unix },
  ]
}

/**
 * The `pair` lines, for a machine installed without a key (from the landing
 * page's line): it runs unpaired and dials nobody until this names the
 * controller and the key it trusts. Run as an administrator, like install.
 * Windows and Linux only: a Mac logs in instead, and `pair` refuses there.
 */
export function pairLines(controller: Controller | null): InstallLine[] {
  if (controller === null) return []
  const args = `pair --pin ${shQuote(controller.fingerprint)} --controller ${shQuote(controller.address)}`
  const windows = `& ${WINDOWS_EXE} pair --pin ${psQuote(controller.fingerprint)} --controller ${psQuote(controller.address)}`
  return [
    { ...WINDOWS, command: windows },
    { ...LINUX, command: `sudo daedalus-agent ${args}` },
  ]
}
