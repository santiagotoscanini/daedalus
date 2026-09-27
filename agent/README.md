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

## Controller mode

`mode = "controller"` is the agent on the box, as nix will run it: one
process as the operator (`daedalus-agent run` under systemd; `serve` is the
same in a terminal), with

- **the status page on loopback only** (`127.0.0.1:7787`): the box adds no
  LAN listener; a node keeps `0.0.0.0`;
- **telemetry** at the level `telemetry` sets (below);
- **the session inside the process**: Claude remote control as its
  transient user unit, reported straight into the service. `daedalus-agent
  session` refuses in this mode. Its log is `claude-rc.log` in the data
  directory's `logs/`. The unit outlives the agent, as on a node: a stop
  or restart of the agent leaves Claude running and the next start
  re-attaches to it — but only while `claude_remote_control` is on. With
  it off the agent adopts nothing: a unit of `claude_unit`'s name that is
  running anyway is left alone and named in the report (`state: "off"`,
  its `detail` saying which unit runs, with its pid, unmanaged). For the
  cut-over, give the controller a `claude_unit` no other unit uses; if
  it ever does see its own name running while off, stop that unit by hand
  or turn remote control on, which adopts it;
- **the local API socket** — the door the Daedalus app uses (below);
- and nothing else: no hello (so no identity key is made), no
  self-update, no keep-awake, no tray, no installer, and no `claude
  update` — nix pins Claude Code on the box (`POST /claude/update` answers
  403 there).

With no hello there is no policy from the box, so nix writes the
controller's own in config.toml:

```toml
mode = "controller"
telemetry = "full"          # full | minimal | off

[controller]
claude_remote_control = true            # default false: the box never starts a second Claude by surprise
claude_workdir = "/home/op/projects/x"  # absent: the most recent trusted project
claude_unit = "daedalus-claude-rc"      # its user unit; absent: daedalus-claude-rc
api_socket = "/run/user/1000/daedalus-agent/api.sock"
api_allowed_uids = [100999]             # host uids served besides the agent's own; default none
```

The table's values are checked only in controller mode (`api_socket` and
`claude_workdir` absolute, `claude_unit` a plain unit name, no root in
`api_allowed_uids`), but a key it does not know is an error in every
mode, so a typo in what nix writes fails loudly. A controller never holds
the machine awake.

What the unit nix writes should carry:

- `Restart=always`. The agent is built with `panic = "abort"`, so a panic
  in any thread — the session's included — ends the whole process;
  systemd brings it back, and the Claude unit, which outlives it, is
  re-attached.
- A `LimitNOFILE` with room: each API connection is a few threads and
  two descriptors, up to 16 at once, beside the telemetry and the
  session's tools.
- A `claude_unit` distinct from any unit the box already runs, and the
  gcroot pin on the `claude` it runs.

### The local API

A unix socket at `api_socket` — absent, `$XDG_RUNTIME_DIR/daedalus-agent/api.sock`,
or `<data_dir>/run/api.sock` where no runtime directory is set. The agent
makes its directory 0700 when it is missing, and never changes one that
exists — but refuses to start when that directory is a symlink, is not
the agent's user's, or can be written by group or others. The socket is
0600. A socket nobody answers on (the connection refused) is stale and
removed; one that answers, or whose backlog is full, means another
instance and the start is refused; any other error refuses too, rather
than remove what it cannot judge. The check never blocks. The socket is
removed on a clean stop. The directory is meant to hold the socket alone,
so it can be mounted into the app's container as it is.

Every connection is checked by its peer's credentials (`SO_PEERCRED`):
the agent's own uid is always served, and so are the host uids
`api_allowed_uids` lists; anyone else gets one `forbidden` line and a
closed connection. Under rootless podman a container's uid 0 is the
operator's uid on the host, but the published app image runs as `node`
(container uid 1000, host uid 100999 on the box), so its container is
refused by default. Two ways in, both supported, the nix step's to choose:
list the uid in `api_allowed_uids`, or run the container with
`--userns=keep-id`, which maps the operator in as itself. The dev-mode
container (`--user=0:0`) passes as it is. With uids listed the file modes
cannot be the gate — the kernel refuses a connect to a 0600 socket before
any peer check — so the socket is made 0666 and a directory the agent
creates 0711, and the peer check is what refuses everyone else; with
none listed they stay 0600 and 0700.

Limits: at most 16 connections at once (one more gets a `busy` line and
is closed); `hello` must arrive within 10 s or the connection is closed;
a write that cannot complete in 10 s — a peer that stopped reading —
closes the connection, so no peer can hold a thread.

The protocol is newline-delimited JSON, one object per line (at most
1 MiB): a request `{"id":<u64>,"m":"<method>","p":{…}}`, an answer
`{"id":…,"ok":…}` or `{"id":…,"err":{"code","msg"}}`, an event
`{"e":"<name>","p":{…}}`. Requests run concurrently, so answers are
matched by `id`. The first request must be `hello`:

```
→ {"id":1,"m":"hello","p":{"api":1,"client":"daedalus-app/2026.9"}}
← {"id":1,"ok":{"api":1,"version":"0.13.0","mode":"controller","hostname":"s2-server","capabilities":["claude.remote_control","telemetry.full"]}}
```

Another API version gets `{"code":"version",…,"supported":1}` — the
version is read before anything else, and fields the agent does not know
in the envelope and in `hello` are ignored, so a newer client always
hears which version this agent speaks; any other request first gets
`bad_request`. A method's own parameters are exact (today, none but
`hello`'s). The methods — fixed verbs, none taking a command, a path or a
flag:

| method             | answers                                                              | needs                   |
|--------------------|----------------------------------------------------------------------|-------------------------|
| `system.info`      | version, mode, api, hostname, OS facts, uptimes, the role table, capabilities | —              |
| `claude.status`    | `{reporting, wanted, report}`: the session's last report, or `reporting: false` | `claude.remote_control` |
| `claude.restart`   | `{queued: true}`; the session restarts the server at once (`unavailable` while remote control is off or no session reports) | `claude.remote_control` |
| `claude.update`    | `{queued: true}`; never offered on the controller                    | `claude.update`         |
| `telemetry.get`    | `{level, telemetry}`: the document at the configured level           | —                       |
| `events.subscribe` | `{}`, then `claude.changed` `{reporting, state, pid}` and `telemetry.updated` `{sampled_at}` | — |

Capabilities come from the role table and the config, never from the OS:
`claude.remote_control` where a session runs, `claude.update` where the
agent may update Claude Code (a node's role, not the controller's), and
`telemetry.full` or `telemetry.minimal`. A method whose capability is
absent answers `unsupported`. `claude.changed` goes out when a session
starts reporting, when its state or pid moves, and when it stops
reporting for 30 s (`reporting: false`, state and pid null);
`telemetry.updated` with every sample. Events are best effort: a
subscriber whose queue fills loses events, not its connection (one that
stops reading altogether is closed by the write timeout). `src/api/wire.rs` has
every type and golden tests pinning each one's exact JSON; `src/api/mod.rs`
the rules above.

Nothing here reaches another machine yet: the machines' connections to
the controller, and the app's side of this socket, come later (PLAN,
feature 13).

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
daedalus-agent run                  service entry point; what the SCM, launchd or systemd calls (and nix, for the controller)
daedalus-agent serve                the same work in the foreground, in a terminal
daedalus-agent session              the Claude session without a tray: the Linux user unit (refused where the tray runs it, and on the controller)
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
# mode = "node"           # node | controller (see "Controller mode")
# telemetry = "full"      # full | minimal | off
# updates = "self"        # self | staged | external
# data_dir = "…"          # see above
# claude_rc = "unit"      # child | unit; absent: child on Windows and macOS, unit on Linux
```

`telemetry = "full"` reads everything above; `minimal` reads the machine
and how it is doing — make, model, firmware, OS, processor, memory,
volumes, GPUs, temperatures, network, battery, the process count,
providers and what could not be read — and never reads the drives
(serials, SMART), services, browsers, installed applications or pending OS
updates; processes are sampled for the count, but the list is not
reported, and a provider such as Lemonade shows only while it answers (an
installed but stopped one is found through the application list, which
`minimal` does not read); `off` reads nothing (the page's `telemetry` is
null, `/metrics` empty).

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
