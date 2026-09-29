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
 * The three lines, each carrying `--controller` and `--pin` (`-Controller`,
 * `-Pin`): the machine dials that address and trusts only that key. The
 * agent refuses to install without a pin — it trusts no controller it was
 * not told of — so without the controller's answer there is no line to
 * give, and none is returned.
 */
export function installLines(
  controller: { address: string; fingerprint: string } | null,
): InstallLine[] {
  if (controller === null) return []
  const unix = `curl -fsSL ${INSTALL_SITE}/install.sh | sudo sh -s -- --controller ${shQuote(controller.address)} --pin ${shQuote(controller.fingerprint)}`
  // A script block takes parameters where `irm … | iex` cannot; the
  // execution policy line is the README's, joined so it pastes as one.
  const windows = `Set-ExecutionPolicy -Scope Process Bypass -Force; & ([scriptblock]::Create((irm ${INSTALL_SITE}/install.ps1))) -Controller ${psQuote(controller.address)} -Pin ${psQuote(controller.fingerprint)}`
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
