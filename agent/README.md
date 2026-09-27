# daedalus-agent

The box's presence on a machine it does not run: a Windows service, a
macOS launchd daemon or a Linux systemd service, with a tray / menu bar app
beside it where there is a desktop. It

- **holds the machine awake** while the box's policy says so — a Windows
  power request (`powercfg /requests`), a macOS IOKit assertion
  (`pmset -g assertions`) or a logind inhibitor on Linux
  (`systemd-inhibit --list`), plus, on Windows, the power plan's sleep and
  hibernate timers set to never;
- **answers a status page** on the LAN at `http://<machine>:7787/status`:
  machine facts, a summary of Claude Code and the public half of the
  telemetry, nothing that identifies a person. `/metrics` renders the
  telemetry for Prometheus. The full Claude report (`/claude`) and the full
  telemetry (`/telemetry` — serials, processes, services, pending updates,
  installed applications) answer only on loopback or to the node token the
  box mints at approval. `src/status.rs` has the routes;
- **reports the machine** — hardware, OS, usage, drives and their health,
  temperatures, network, battery, pending OS updates, installed browsers
  and applications, and the **providers** on it (a model server such as
  Lemonade, as presence only: kind, port, version, answering or not; the
  box may set the port in the policy, `providers.lemonade.port`). What is
  read, how often, and what stays off the open page: the header of
  `src/telemetry.rs`, and each OS's collector (`src/os/*/telemetry.rs`);
- **announces itself to the box** every minute with a hello signed by an
  ed25519 key made on first start (`src/identity.rs`). The box is found
  through the `_daedalus._tcp` SRV record under the DHCP search domain (or
  `control_plane_url` in the config) and lists the machine on
  Settings › Machines as "wants to join" until an admin approves it. The
  answer then carries the box's **policy** — hold it awake or not, run
  Claude remote control or not and where, provider ports — and one-shot
  instructions: check for updates now, update Claude Code, restart Claude
  remote control (`src/hello.rs`);
- **runs Claude Code's remote control** the way the box runs its own: the
  **session** — the process with the user's Claude login — supervises
  `claude remote-control --verbose`, restarts it with backoff, logs its
  output to `claude-rc.log`, and reports its state, versions, sessions and
  credential dates (never a token) to the service (`src/session.rs`,
  `src/claude/`). On Windows and macOS the session lives in the tray, so
  nobody logged on means no server, and a machine that reboots unattended
  wants automatic sign-in. On Linux the session is a systemd user unit that
  runs with nobody logged in, and the server is a unit of its own (below);
- **shows itself in the tray** (`src/tray.rs`): the daedalus mark — ember
  when all is well, an amber dot when an update is pending, the hold failed
  or Claude is not running, grey when the service does not answer — with
  the state in its tooltip and menu, and the actions: open the status page,
  check for updates, restart Claude remote control, open the logs, open
  Claude's log;
- **updates itself** to the newest `agent-v*` release of this repository,
  verifying every asset against the ed25519 key compiled into it.

## Node and controller

`mode` in config.toml says what the agent is, and `src/role.rs` holds the
one table of what runs for each: a **node** — every machine that joins the
network — runs all of the above; the **controller** — the box itself, NixOS
by definition, the same Linux code built and configured by nix — runs the
status page, telemetry and the session, and no hello, self-update,
keep-awake, tray or installer (`install` and `uninstall` refuse there).

## Install

From an administrator PowerShell on a Windows machine:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
irm https://daedalus.toscanini.me/install.ps1 | iex
```

[`install.ps1`](install.ps1) downloads the release into
`C:\Program Files\daedalus-agent\` and runs `daedalus-agent install`, which
registers the `daedalus-agent` service (LocalSystem, automatic start,
restart on failure), registers the tray under the machine's Run key and
starts it as the desktop user, opens TCP 7787 to the local subnet, writes
`config.toml` if there is none, and starts the service. Re-running replaces
the binaries and keeps the config. `daedalus-agent uninstall` removes the
service, the tray's Run key and the firewall rule; the data directory stays.

On a Mac or a Linux machine, from a terminal, as the user whose Claude Code
should run there:

```sh
curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh
```

[`install.sh`](install.sh) on a Mac downloads the two universal binaries,
registers the service as a LaunchDaemon (root, at boot, kept alive) and the
menu bar app as a LaunchAgent for every user, starts both, and links
`daedalus-agent` into `/usr/local/bin`. `sudo daedalus-agent uninstall`
removes both jobs.

On Linux — a distribution running systemd 240 or newer (2018 onwards;
`install` refuses an older one), on x86_64 or aarch64 (NixOS is configured
through nix instead, and the script says so) — it takes the newest release
that carries a build for the machine's architecture ("no Linux release
yet" when none does), puts the static service in `/opt/daedalus-agent/bin`
— with the tray beside it on x86_64 — links it into `/usr/local/bin`, and
runs `daedalus-agent install`, which

- keeps the binaries in `/opt/daedalus-agent/bin` — copying itself there
  when run from anywhere else, and refusing a directory there that is not
  root's or that group or others can write, since the service runs from it
  as root;
- writes `/etc/systemd/system/daedalus-agent.service` (root, at boot,
  `Restart=always` — an update exits 3 and systemd starts the new binary —
  with the hardening its jobs allow) and enables and starts it;
- writes `/etc/systemd/user/daedalus-agent-session.service` and, for the
  user who ran `sudo` (`$SUDO_USER`), turns lingering on
  (`loginctl enable-linger`) and enables and starts it in their own systemd
  manager — the session runs from boot, with nobody logged in. It talks to
  that manager on its own socket, so no D-Bus session bus
  (dbus-user-session) is needed;
- where the tray was installed, writes `/etc/xdg/autostart/daedalus-agent-tray.desktop`,
  so every graphical login starts it;
- writes `config.toml` if there is none, and opens nothing in the firewall.
  On a machine that filters inbound traffic, allow the status page's port
  to the LAN: `sudo ufw allow from 192.168.0.0/24 to any port 7787 proto tcp`
  (ufw), or `sudo firewall-cmd --permanent --add-port=7787/tcp && sudo
  firewall-cmd --reload` (firewalld).

`sudo daedalus-agent uninstall` stops and removes the service, the session
and the tray's entry, stops the Claude server, and turns lingering off
again if `install` turned it on (`session.json` in the data directory
records who and whether); the binaries, config and identity stay.

Re-running either script replaces the binaries and keeps the config. The
site serves both scripts from `main`, so neither command names a version.
Trust at install is HTTPS to GitHub; every update after that is verified by
the agent against the release key it carries.

### Linux: Claude remote control as a unit

On Linux the session does not run `claude remote-control` as its child: it
starts it as a transient systemd user unit, `daedalus-claude-rc.service`
(`systemd-run --user`), watches it with `systemctl --user show`, stops it
with `systemctl --user stop`, and when the session itself restarts — an
agent update, a crash — it finds the unit still running and re-attaches to
it. So updating or restarting the agent never ends a Claude session. The
unit keeps its exit status (`RemainAfterExit=yes`) until the session has
read it; systemd appends its output to the session's `claude-rc.log`,
which is what the report's `log` names and where the session reads the
server's banner back from. `src/claude/unit.rs` has the details;
`claude_rc = "child"` in config.toml goes back to the child.

The tray on Linux is a UI only: it shows the session unit through the
service, its "Restart Claude remote control" goes to the session by way of
the service, and quitting it stops nothing. It needs GTK 3 and an
AppIndicator library (`libayatana-appindicator3`); without a graphical
session or without that library it says so in one line and exits, and
nothing else changes. aarch64 machines run without a tray in this version
(and the aarch64 build has not yet run in CI: its first run is the first
Linux release).

The awake hold is a logind inhibitor on `sleep:idle` in block mode, held by
a `systemd-inhibit … sleep infinity` child of the service for as long as
the policy wants it; `systemd-inhibit --list` shows it with its reason.
Block mode on `sleep` means more than on Windows or a Mac: while the box's
policy says "keep awake", a suspend the user asks for (the Suspend menu
item, `systemctl suspend`) is refused too, not only the idle one. Turning
the policy off for the machine on Settings › Machines releases the lock at
once.

Until the agent's local calls move to a unix socket with peer credentials
(PLAN, feature 13), the status page trusts loopback: any user or process on
the machine can read the full Claude report at `127.0.0.1:7787/claude` and
ask for a Claude restart — worth knowing on a Linux machine several people
log in to.

## Verbs

```
daedalus-agent install [--port N]   register and start the service, the session and the tray (administrator / sudo)
daedalus-agent uninstall            stop and remove them (administrator / sudo)
daedalus-agent run                  service entry point; what the SCM, launchd or systemd calls
daedalus-agent serve                the same work in the foreground, in a terminal
daedalus-agent session              the Claude session without a tray: the Linux user unit (refused where the tray runs it)
daedalus-agent status               print the running agent's status page
daedalus-agent update [--apply]     check the release feed now; --apply installs
daedalus-agent claude restart       ask the session to restart `claude remote-control`
daedalus-agent version
```

## On the machine

Windows:

```
C:\Program Files\daedalus-agent\daedalus-agent.exe        the service (.old / .new around an update)
C:\Program Files\daedalus-agent\daedalus-agent-tray.exe   the tray, started at logon
C:\ProgramData\daedalus-agent\config.toml                 local knobs, never policy (src/config.rs); edit and restart
C:\ProgramData\daedalus-agent\state.json                  the last update check and install
C:\ProgramData\daedalus-agent\identity.key                the machine's key, DPAPI-wrapped
C:\ProgramData\daedalus-agent\logs\agent.log.*            daily-rotated log
C:\ProgramData\daedalus-agent\logs\claude-rc.log          what `claude remote-control` printed
```

macOS:

```
/Library/Application Support/daedalus-agent/bin/daedalus-agent        the service (.old / .new around an update)
/Library/Application Support/daedalus-agent/bin/daedalus-agent-tray   the menu bar app
/Library/Application Support/daedalus-agent/{config.toml,state.json,identity.key,logs/}
/Library/LaunchDaemons/me.toscanini.daedalus-agent.plist              the service's job
/Library/LaunchAgents/me.toscanini.daedalus-agent-tray.plist          the menu bar app's job
~/Library/Logs/daedalus-agent/                                        the menu bar app's logs (claude-rc.log)
```

Linux:

```
/opt/daedalus-agent/bin/daedalus-agent                the service (.old / .new around an update); /usr/local/bin links to it
/opt/daedalus-agent/bin/daedalus-agent-tray           the tray, x86_64 desktops only
/var/lib/daedalus-agent/{config.toml,state.json,identity.key,session.json,logs/}
/etc/systemd/system/daedalus-agent.service            the service's unit
/etc/systemd/user/daedalus-agent-session.service      the session's unit, enabled for one user, lingering
/etc/xdg/autostart/daedalus-agent-tray.desktop        the tray, at every graphical login
~/.local/state/daedalus-agent/                        the session's and the tray's logs: session.log.*, claude-rc.log
daedalus-claude-rc.service (transient, user)          Claude remote control, while it runs
```

(`$XDG_STATE_HOME/daedalus-agent` when that is set.) To run `serve` or
`session` as an ordinary user without installing, set
`DAEDALUS_AGENT_DATA_DIR` to a directory that user owns: the logs, the
session's included, go there, and the Claude unit gets a name of its own
(`daedalus-claude-rc-<hash of the directory>`), so a development run never
touches an installed agent's server.

`data_dir` in config.toml moves state, identity and logs of an installed
agent; config.toml stays where it is. `DAEDALUS_AGENT_DATA_DIR` moves the
whole directory, config.toml included, and wins over `data_dir` — but only
for the process started with it, so it is a `serve` and development knob:
the service, the tray and `sudo` never see it, and `install` and
`uninstall` refuse to run while it is set. Both must be absolute paths; a
relative one stops the agent at start with a message saying so.

### config.toml

`install` writes the first six keys; every key is optional, and a key the
agent no longer knows is ignored. The header of
[`src/config.rs`](src/config.rs) is the reference.

```toml
port = 7787               # the status page's LAN port
update_check_secs = 600   # how often the release feed is asked
auto_update = true        # the older spelling of `updates`
log_level = "info"        # "debug" for a bug report
search_domains = []       # more domains to ask for _daedalus._tcp
hello_secs = 60           # how often the hello goes out
# control_plane_url = "https://…"   the box, when DNS cannot find it
# mode = "node"           # node | controller (see "Node and controller")
# telemetry = "full"      # full | minimal | off — carried, not acted on yet
# updates = "self"        # self | staged | external
# data_dir = "…"          # see above
# claude_rc = "unit"      # child | unit; absent: child on Windows and macOS, unit on Linux
```

`updates = "self"` installs a newer release (the default); `staged` and
`external` only report it, as `auto_update = false` does. With no
`updates` key, `auto_update` decides; with both, `updates` wins.

Claude Code is looked for in `~/.local/bin`, npm's bin, Homebrew's bin and
PATH. Its remote control runs in the directory the policy names, else the
most recently used trusted project (Claude refuses the home directory;
`src/claude/workdir.rs`).

## How an update happens

Every ten minutes (`update_check_secs`), and when the tray or the box asks,
the agent lists the repository's releases, keeps the `agent-v<semver>` ones
that are neither drafts nor prereleases, and takes the highest above its own
version that carries this target's required assets (on Linux the service
alone; the tray is optional and follows only where it is installed). Unless
config.toml says only to report it (`updates`, or `auto_update = false`),
it downloads those executables and their `.sig`s, checks each raw ed25519
signature against `RELEASE_PUBLIC_KEY_HEX` in [`src/update.rs`](src/update.rs),
renames the running binaries to `.old`, moves the new ones into place and
exits with code 3. The service's recovery action (launchd's KeepAlive on
macOS, `Restart=always` on Linux) starts it on the new binary; the tray and
the session see the page report a version other than their own and restart
(the Linux session unit by leaving, for systemd to start it again — its
Claude unit keeps running and is re-attached); the next clean start deletes
the `.old` files. A release whose signature fails is reported on the status
page and never installed.

## Releasing

Bump `version` in `Cargo.toml`, commit, tag `agent-v<version>`, push the
tag. [`.github/workflows/agent.yml`](../.github/workflows/agent.yml) builds
the Windows binaries, the macOS universal binaries, the static Linux
service for x86_64 and aarch64 (musl, rustls; each on a runner of its own
architecture) and the Linux tray for x86_64 (glibc, GTK), signs every one
with the `AGENT_SIGNING_KEY` secret, checks the signatures against the
compiled-in public key, and publishes the release. The tag and `Cargo.toml`
must agree or the build refuses.

The private key has no recovery path but the operator's copies; losing it
strands every installed agent on its version. Rotation is a release signed
with the old key that carries the new public key.

**Apple's signature.** The macOS binaries are codesigned (Developer ID,
hardened runtime) and notarized on the runner when the repository's
`release` environment holds `APPLE_CERTIFICATE` (the Developer ID
Application .p12, base64), `APPLE_CERTIFICATE_PASSWORD`,
`APPLE_SIGNING_IDENTITY` (the certificate's common name), `APPLE_API_KEY`
(the App Store Connect .p8), `APPLE_API_KEY_ID` and `APPLE_API_ISSUER`.
Without them the job warns and ships the binaries unsigned by Apple —
launchd runs them all the same, and the updater trusts only our own
signature. Bare executables notarize but cannot be stapled; a Mac that is
online fetches the ticket.

## Developing without Windows or a Mac

[`gate.sh`](gate.sh) runs fmt, clippy for Linux (with the tray, and
without it as the static service is built), Windows
(`x86_64-pc-windows-gnu`) and macOS (`aarch64-apple-darwin`), the tests,
and the static x86_64 musl build, in a throwaway rust container with GTK's
development packages: `agent/gate.sh [fmt|check|test|musl|all]`. The macOS
check needs no Apple toolchain because TLS there comes from the OS through
native-tls; Linux uses rustls over the system's CA bundle (Mozilla's roots,
compiled in, only when the system has none), so no OpenSSL is linked
anywhere. The tests
are platform-neutral — the parsers of Windows' SMBIOS table, of macOS's
tools and of Linux's `/proc`, `/sys` and package managers included, which
live outside the per-OS code (`src/telemetry/parse/`), the DNS SRV codec
(`src/dns.rs`), the systemd units `install` writes (as golden text) and the
Claude unit's command line — and the service, the power request, the tray
and `install` are exercised on the machines themselves.

Everything that differs by OS is behind `src/os/`: one module per OS
(`windows/`, `macos/`, `linux/`) exporting the same names, selected once
in `src/os/mod.rs`, so an OS that lacks one is a compile error. Commands
whose output is captured under a deadline — PowerShell, Apple's tools, the
Linux tools, `claude --version` and `claude update` — go through one helper,
`src/exec.rs`; macOS's `launchctl_timeout` (`src/os/macos/launchd.rs`) keeps
its own.
