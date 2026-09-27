// The agent's install one-liners, naming the controller and pinning its key
// (agent/README.md "Install"). The scripts are the engine's, served by its
// public site from `main`, so no line names a version; where the machine
// connects and which key it trusts are this box's, read from the controller
// (`system.info`), never written here.
//
// Pure, for Settings › Machines: the page draws the lines and a copy button.

/** Where the engine's site serves agent/install.ps1 and agent/install.sh. */
const INSTALL_SITE = 'https://daedalus.toscanini.me'

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

/**
 * The three lines. With the controller known, each carries `--controller`
 * and `--pin` (`-Controller`, `-Pin`): the machine dials that address and
 * trusts only that key, confirmed from its first connection. Without one
 * (the controller did not answer), the bare lines — a machine then finds
 * the controller through DNS and trusts it on first use.
 */
export function installLines(
  controller: { address: string; fingerprint: string } | null,
): InstallLine[] {
  const unixArgs =
    controller === null
      ? ''
      : ` -s -- --controller ${shQuote(controller.address)} --pin ${shQuote(controller.fingerprint)}`
  const unix = `curl -fsSL ${INSTALL_SITE}/install.sh | sudo sh${unixArgs}`
  // A script block takes parameters where `irm … | iex` cannot; the
  // execution policy line is the README's, joined so it pastes as one.
  const windows =
    controller === null
      ? `Set-ExecutionPolicy -Scope Process Bypass -Force; irm ${INSTALL_SITE}/install.ps1 | iex`
      : `Set-ExecutionPolicy -Scope Process Bypass -Force; & ([scriptblock]::Create((irm ${INSTALL_SITE}/install.ps1))) -Controller ${psQuote(controller.address)} -Pin ${psQuote(controller.fingerprint)}`
  return [
    { os: 'windows', label: 'Windows', where: 'an administrator PowerShell', command: windows },
    {
      os: 'macos',
      label: 'macOS',
      where: 'Terminal, as the user whose Claude runs there',
      command: unix,
    },
    {
      os: 'linux',
      label: 'Linux',
      where: 'a terminal (systemd 240 or newer, x86_64 or aarch64)',
      command: unix,
    },
  ]
}
