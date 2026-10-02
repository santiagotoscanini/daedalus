# daedalus-agent

The box's presence on a machine it does not run: a Windows service, a
macOS launchd daemon or a Linux systemd service, with a tray / menu bar app
beside it where there is a desktop. It

- **holds the machine awake** while the box's policy says so — a Windows
  power request (`powercfg /requests`, plus the plan's sleep and hibernate
  timers set to never), a macOS IOKit assertion (`pmset -g assertions`), a
  logind inhibitor on `sleep:idle` in block mode on Linux
  (`systemd-inhibit --list`; block mode refuses a suspend the user asks for
  too, while the policy holds);
- **keeps one connection to the controller**, the box's own agent, and
  talks to nothing else (see "The link to the controller");
- **listens on nothing, loopback included**: the tray, the session and the
  verbs reach the service through a local socket that knows who is calling
  (see "The local socket");
- **reports the machine** — hardware, OS, usage, drives and their health,
  temperatures, network, battery, pending OS updates, browsers and
  applications, at the level `telemetry` sets (the header of
  `src/telemetry.rs`, and each OS's collector);
- **reads its providers** — a model server such as Lemonade, on loopback,
  its install read off the install itself — runs the box's two residency
  verbs on them, and installs, updates, starts and stops them (see
  "Providers");
- **follows the box's policy** once an admin approves the machine on
  Settings › Machines — keep awake, Claude remote control and where,
  providers (port, pinned release, power, startup), santree — and its
  commands (check for updates, update Claude Code, restart Claude). The
  last policy is kept in `policy.json`, so a restart starts from it;
- **runs Claude Code's remote control** the way the box runs its own, as a
  job of the OS that outlives the agent, keeps the roster of Claude
  sessions with its three verbs, and brings back the sessions a restart of
  the server ended (see "Claude outside the agent");
- **shows itself in the tray** (see "The menu");
- **updates itself** to the newest signed `agent-v*` release, and goes back
  to the previous binaries when a new one does not prove itself (see "How
  an update happens").

How the agent fits the rest of daedalus — the controller as the app's one
door to the machines and to root, the trust boundaries — is
[ARCHITECTURE.md](../ARCHITECTURE.md). This file is the agent's own
behaviour; each module's header is the reference for its protocol.

## Node and controller

`mode` in config.toml says what the agent is, and `src/core/role.rs` holds
the one table of what runs for each. A **node** — every machine that joins
the network — runs all of the above. The **controller** is the box itself:
NixOS, the same Linux code built with the `controller` feature (no node's
release carries it) and configured by nix. It runs the local socket,
telemetry, the session (inside the service), the app's API socket, the
listener for the machines' links and the metrics page — and no link of its
own, self-update, keep-awake, tray or installer (`install` and `uninstall`
refuse there). A node's build refuses `mode = "controller"`.

## Controller mode

`mode = "controller"` is the agent on the box: one process as the operator
(`daedalus-agent run` under systemd; `serve` is the same in a terminal),
with

- **the app's API socket** (`src/controller/api/`): a unix socket the
  app's container mounts, served to the agent's own uid and the host uids
  `api_allowed_uids` lists, newline-delimited JSON, versioned by `hello`,
  fixed verbs only. The method table, the limits, the capabilities and the
  events are the header of `src/controller/api/mod.rs`; every type, with
  golden tests pinning its JSON, is `src/api/wire.rs`, from which the app's
  TypeScript is generated (see "The app's wire types");
- **its own identity key** (`identity.key`, 0600, made on first start):
  what every machine pins. `controller.rotate` hands its trust to a new
  one (see "Rotating the controller's key");
- **the listener for the machines' links**, where `[controller] listen`
  names an address, and the registry of machines the API's `nodes.*` read
  (`src/controller/link/`);
- **the session host's two files**, where `[controller.session_host]`
  names them: the allow-list it writes from the app's decisions and the
  status file it reads every 2 s (`src/controller/session_host.rs`);
- **the relay to the root helper**, where `[controller] root_socket` names
  its socket: `root.run`, `root.follow`, `root.runs`, each run's lines and
  outcome kept for an hour (`src/controller/root/`; the helper itself and
  its verb table are ARCHITECTURE.md's "The root helper");
- **the metrics page** on `[controller] metrics_listen`, for one reader,
  the box's Prometheus: `GET /healthz` and `GET /nodes/metrics` — every
  connected machine's telemetry, Claude and provider series, and the
  controller's own Claude series labelled as a machine of its own, each
  series carrying `node`, `host`, `machine` and `os` — and 404 for
  everything else (`src/controller/metrics_page.rs`,
  `src/telemetry/metrics.rs`). Nix names the box's LAN address, where the
  Prometheus container's connections arrive through pasta's host alias,
  and keeps the port closed in the firewall;
- **the session inside the process**: Claude remote control as its
  transient user unit, only while `claude_remote_control` is on — with it
  off the agent adopts nothing, and a unit of `claude_unit`'s name running
  anyway is left alone and named in the report. No `claude update`: nix
  pins Claude Code on the box.

With no controller above it, nix writes the controller's own policy:

```toml
mode = "controller"
telemetry = "minimal"                    # full | minimal | off

[controller]
claude_remote_control = true             # default false: the box never starts a second Claude by surprise
claude_workdir = "/home/op/projects/x"   # absent: the most recent trusted project
claude_unit = "daedalus-claude-rc"       # its user unit; absent: daedalus-claude-rc
api_socket = "/run/daedalus-controller/api.sock"  # absent: $XDG_RUNTIME_DIR/daedalus-agent/api.sock
api_allowed_uids = [100999]              # host uids served besides the agent's own
root_socket = "/run/daedalus-root/root.sock"  # the root helper; absent: no root.*
listen = "0.0.0.0:7788"                  # the machines' links; absent: no listener
metrics_listen = "192.168.0.2:7787"      # the metrics page; absent: none
advertise = ["box.example.org:7788"]     # what machines should dial, for the app

[controller.session_host]                # absent: no session host
address = "box.example.org:7789"
allow_list = "/srv/state/controller/session-host-allow.json"
status_file = "/srv/state/session-host/status.json"
bin = "/nix/store/…/bin/daedalus-session-host"
config = "/nix/store/…-daedalus-session-host.json"
```

Paths must be absolute and addresses address:port (or host:port for what
machines dial), and a key the table does not know is an error, in every
mode: a typo in what nix writes fails loudly. The header of
`src/core/config.rs` has every key.

What the unit nix writes carries (`nix/stacks/daedalus/controller.nix`):
`Restart=always` (the agent is built with `panic = "abort"`, and the Claude
unit, which outlives it, is re-attached); a `LimitNOFILE` with room for 16
API connections and 64 links; the link's port open to the LAN alone, the
metrics page's to none; a `claude_unit` no other unit uses, and
`nix-store` on its PATH (see "The claude a job runs, pinned").

## The crate

```
src/
  lib.rs             the module list, grouped as below
  bin/               daedalus-agent (the service and its verbs), daedalus-agent-tray (feature `tray`)
  service/           agent_main: the instance lock, a role's parts started, the workers,
                     the awake hold (HoldKeeper), an update's probation, the Windows tray watchdog
  session.rs         the Claude session: supervises the server, reports to the service (Session, Watcher)
  tray/              the tray: the Tray and its clicks; model.rs (what each row says, tested),
                     menu.rs (the menu built and drawn), elevate.rs (pairing behind the OS's prompt)
  core/              config.toml, the role table, paths, the persisted state, the machine's facts, the log;
                     shared/ — what the service's threads share, one hub per concern, each its own lock —
                     and status.rs, the status document built from it
  ipc/               the one envelope (rpc.rs), line framing (jsonl.rs), deadlines that do not move
                     (deadline.rs), doors that know their callers (door.rs), the local socket (local/)
  node/              a machine's side: the link (link.rs), a log-in (enroll.rs) and its tunnel (tunnel/),
                     pairing (pair.rs), the awake hold (power.rs), its settings (settings.rs), providers/,
                     santree's door (santree.rs), self-update (update/)
  controller/        the box's side, feature `controller`, Linux only: api/, the machines' links (link/),
                     key rotation (rotation.rs), session_host.rs, root/ (relay and helper), metrics_page.rs
  api/               the app↔controller contract both sides share: wire.rs, the version, capabilities
  link/              the link's protocol: TLS (tls.rs) over the crate's own crypto provider (crypto.rs),
                     certificates (cert.rs), the messages (wire.rs)
  claude/            Claude Code: the supervisor, the roster, the session verbs, recovery, gcroots
  telemetry/         the machine's document, its parsers, Prometheus text
  jobs/              a Claude job of the OS, as pure command lines; os/*/jobs.rs make the calls
  os/                everything that differs by OS, one module per OS exporting the same names
  dns.rs, discover.rs, exec.rs, http.rs, identity.rs, net.rs, private.rs, procfs.rs, time.rs, util.rs
```

## The link to the controller

Every machine keeps ONE outbound connection to the controller, and only
the controller talks to the app: a star with the box at the centre. The
link carries control messages — who a machine is, how it is, what it runs,
and the box's word back — never data-plane traffic. The header of
`src/link/mod.rs` is the reference (transport, framing, trust, limits);
`src/node/link.rs` is the machine's side, `src/controller/link/` the
controller's.

**Transport.** TLS 1.3 on every OS through rustls, over pure-Rust
primitives the crate plugs in itself (`src/link/crypto.rs`), so the link
builds no C crypto library; Windows builds none at all, and the gate checks
it. Each end presents a certificate made from its ed25519 identity key;
there is no CA and no hostname. A key is shown as the SHA-256 of its public
key, four hex characters to a group (`3f2a:9c01:…`); a node id is the first
sixteen hex characters of the same digest.

**Where it connects, and whom it trusts.** The address is config.toml's
`controller_address`, else the SRV record `_daedalus-controller._tcp` under
the search domains DHCP handed out (and `search_domains`). The key is
config.toml's `controller_pin`, which `install --pin` or `pair` writes (a
Mac's log-in) and nothing else supplies — nothing is trusted on first use.
A machine without a pin is **unpaired** and dials nobody. A controller that
presents another key is refused, and the status page and the tray say
**controller key changed**.

**Enrollment.** A key the app has not approved waits PENDING: the machine
shows both fingerprints to compare before an admin approves it on Settings
› Machines; approval upgrades the open connection and sends the policy. A
revoked key is told so and disconnected. Once approved the machine pushes
its status, telemetry, Claude report and roster, and providers document,
each on change and at least every minute; the controller sends the policy
and commands, each acknowledged at once.

**Rotating the controller's key** (`src/controller/rotation.rs`).
`controller.rotate` makes a new key beside the old one and signs, with the
OLD key, the statement that the new one succeeds it. Until the grace period
ends the listener presents each machine the key it pins (the machine names
it in the TLS server name), and every connection under the old key gets the
statement once: the machine checks it against the key its handshake just
proved, re-pins `controller_pin` in config.toml in place, and reconnects.
A machine that was off all along, or older than 0.19.0, is re-pinned by
hand. Rotation is no way out of a compromised key — whoever holds it can
sign a statement of their own; a leaked key is replaced by pinning a new
one on every machine (`pair --pin`).

**Files that hold trust.** `identity.key`, `config.toml` and `policy.json`
are read only when their owner is trusted (SYSTEM or Administrators on
Windows, root or the agent's own user elsewhere), and `install` refuses a
data directory or config someone else made. Every file the agent writes is
written whole or not at all, never through a planted link
(`util::write_atomic`). The key is its owner's alone — 0600 on unix, a
protected DACL on Windows — set as it is created.

## Logging in (macOS)

A Mac does not pair: it **logs in**, from the menu bar's "Log in…", and
gets a WireGuard tunnel of its own to the box — an ordinary client of the
box's wg-easy — through which alone it reaches the controller's link and
the session host, at home or away. A Mac with a pin but no tunnel config is
logged out, and dials nobody. `src/node/enroll.rs` is the reference for the
flow and who may run each step.

1. "Log in…" asks for the app's address, and the service answers with the
   Mac's key, fingerprint and a PKCE challenge; the verifier stays in the
   service's memory.
2. The browser opens the app's enroll page; the operator signs in, sees a
   consent page naming the Mac and its full key, and confirms — or
   declines, and nothing changes.
3. The app approves the node, makes its wg-easy client and sends the
   browser to a loopback callback with a single-use code. The menu bar asks
   for an administrator's password once and runs `daedalus-agent
   enroll-finish CODE` as root: the service redeems the code with its
   verifier, keeps the client config in `tunnel.toml` (root's, 0600) and the
   pin and the controller's in-tunnel address in config.toml, and links
   through the tunnel.

"Log out" tells the controller (the app deletes the wg-easy client) and
forgets the log-in: pin and address out of config.toml, the tunnel down,
`tunnel.toml` and the kept policy deleted. A Mac the box revokes forgets
it the same way.

**The tunnel** (`src/node/tunnel/`) runs in the service: boringtun and
smoltcp on one thread — no utun device, no route — reaching one address,
the box's, and dialling nothing else. Linux builds the same code, so its
tests and `e2e-tunnel.sh` (against a real wg-easy) run there; Windows
builds none of it.

## The local socket

The tray, the session and the verbs (`daedalus-agent status`, `claude
restart`) reach the service through one local socket (`src/ipc/local/`;
its header has the methods): `run/agent.sock` in the data directory on
macOS and Linux, 0666 in a 0711 directory with the kernel's word on the
peer as the gate; the named pipe `\\.\pipe\daedalus-agent` on Windows,
whose DACL lets nobody create a second instance. It serves root (SYSTEM),
the service's own user, and the users the machine runs Claude for — on
Linux the session user `install` recorded, on macOS the console user, on
Windows every logged-on user — and the client checks the other end is the
service, so a socket squatted while the service is down cannot give the
session orders. One request per connection, within a deadline on both ends
(`src/ipc/door.rs`). There is no pairing method: naming the controller is
an administrator's.

**santree's socket** (`src/node/santree.rs`, macOS and Linux):
`run/santree.sock` beside it, served to root and the user who installed the
agent only — a connection there is a shell as the operator on the box. For
each connection the agent opens TLS 1.3 to the box's session host
(`session-host/`), proving this machine's key and pinning the host's from
its policy, and pipes the bytes without reading them; its first line says
`ok`, or why not (`santree_off`, `host_key_changed`, `unavailable`).

## The menu

The menu (`src/tray/`) has one fixed shape, so it redraws in place while it
is open: a header with a status dot (green connected; amber connecting,
waiting for approval, an update restarting, the hold or Claude not
running, a setting that did not take; red the service silent,
disconnected, the box's key changed, revoked; grey logged out), the
version, Open Daedalus and this machine's page, the three switches, then
Connection ▸, Claude ▸, santree ▸, Updates ▸, Troubleshoot ▸, and Log in…
/ Pair with the box…, Uninstall… (a Mac) and Quit. A Mac's rows carry
Lucide glyphs (ISC, `assets/LICENSE-lucide`; `macos/icons/`); Windows draws
no glyphs and has no santree rows. Quitting ends the menu alone.

**The switches** — Keep awake, Claude Remote Control, santree on the box —
are the machine's own settings and the box decides them
(`src/node/settings.rs`): a click asks the service, which sends the link's
`policy_request`; the switch shows the value on its way until the box's
policy carries it, and why when it does not within 30 seconds. santree ON
is never sent: it opens the page in Daedalus where an admin confirms it.
Only the user who installed the agent (or root) may change them; on Windows
every user at the desktop may change the two there.

What the tray stands over is the OS's choice: on Windows and macOS it runs
the session itself, in the user's desktop session with the user's Claude
login; on Linux the session is a user unit of its own and the tray only
shows it (GTK 3 and `libayatana-appindicator3`, x86_64 desktops; without
them it says so and exits).

## Install

From an administrator PowerShell on Windows:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
irm https://daedalus.toscanini.me/install.ps1 | iex
```

[`install.ps1`](install.ps1) puts the release in `C:\Program
Files\daedalus-agent\` and runs `daedalus-agent install`, which refuses
any other directory, or one anyone but SYSTEM, Administrators or
TrustedInstaller may write; registers the service (LocalSystem, automatic,
restart on failure) and the tray under the Run key; writes `config.toml`
if there is none; and starts the service. It gives the data directory a
protected DACL (Users may read the kept policy; the key, config.toml,
`agent.lock` and the service's logs are SYSTEM's and Administrators'
alone). Nothing opens in the firewall.

On a Mac (macOS 13 or newer), as the user whose Claude Code should run
there: download the disk image (the website's "Download for Mac", or the
newest release's `daedalus-agent-macos.dmg`), drag **Daedalus Agent** into
Applications and open it. One administrator prompt says what it installs
and for whom; then "Log in…" joins the box. Its `install` copies the bundle
into a staging folder only root can reach, makes it root's, checks its
identifier, its version and that its service answers with that version,
and only then exchanges it into `/Library/Application Support/daedalus-agent/`,
which launchd runs from: the service as a LaunchDaemon, the menu bar app
as a LaunchAgent, both under the app's name in System Settings › Login
Items. It records the user it serves (`installer.json`), which a later
install changes only with `--replace-operator`. "Uninstall Daedalus
Agent…" logs the Mac out and removes the jobs and both copies of the app;
the data directory stays.

On Linux, or a Mac with nobody at it, from a terminal, as the user whose
Claude Code should run there:

```sh
curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh
```

[`install.sh`](install.sh) checks every file against the release's signed
manifest where the machine's openssl can (OpenSSL 3), else trusts HTTPS to
GitHub. On a Mac it runs the bundle's own `install`, as opening the app
does. On Linux (systemd 240 or newer; x86_64 or aarch64; NixOS is
configured through nix instead) it puts the static service in
`/opt/daedalus-agent/bin` (the tray beside it on x86_64), and `install`
writes the service's unit (root, `Restart=always`), the session's user
unit — enabled for the user who ran `sudo`, with lingering on, so Claude
runs with nobody logged in — and the tray's XDG autostart entry.
`uninstall` removes them, stops the Claude server and turns lingering off
again if `install` turned it on; binaries, config and identity stay.

Re-running either script replaces the binaries and keeps the config,
except the two keys `--controller` and `--pin` (`-Controller`, `-Pin`)
set. Neither installs a release older than `MIN_VERSION`.

### Pairing

Windows and Linux pair; a Mac logs in. A machine installed without a pin
is unpaired: the service, session and tray run, but it dials nobody
(`src/node/pair.rs`). Three ways to pair it, each with the key Settings ›
Machines shows:

- **The installer asks** at its end, where it has a terminal.
- **`daedalus-agent pair --pin KEY [--controller HOST:PORT]`**, as root or
  an administrator: config.toml written through `install`'s own writer, and
  the running service told to read it again (`link.reload`); the link
  starts over under the new keys at once. `pair --check` exits 0 when
  paired.
- **The tray's "Pair with the box…"**, while unpaired: it checks the
  pasted key (or a whole pair or install line), then runs `pair`
  **elevated**, behind the OS's own prompt — UAC, the administrator
  password, polkit's `pkexec` (`src/tray/elevate.rs`). Pairing asks what
  `install` asks because the controller a machine trusts commands its
  service.

## Claude outside the agent

Claude remote control and every session the agent resumed run as **jobs of
the OS**, never as the agent's children: the session starts each, watches
it, stops it, and after any restart of its own finds it running by its
name and re-attaches. So updating or restarting the agent never ends a
Claude session. Each job appends to a log of its own (`claude-rc.log`,
`claude-session-<uuid>.log`), rotated in place past 20 MiB. `src/jobs/` has
the pure command lines, `src/os/*/jobs.rs` the calls.

- **Linux and the controller**: a transient systemd user unit
  (`daedalus-claude-rc.service`, `claude-session-<uuid>.service`), stopped
  whole with its cgroup.
- **macOS**: a launchd job in the user's `gui/<uid>` domain, its plist in
  the session's own state directory (never `~/Library/LaunchAgents`), with
  no `KeepAlive` — the supervisor decides what runs again.
- **Windows**: a process detached from the tray, recorded by pid AND
  creation time so a new tray never adopts a later process with the same
  pid. A resumed session's terminal is a ConPTY owned by this binary's
  **holder mode** (`claude-holder`, `src/os/windows/holder.rs`), run from a
  per-version copy so a long session never blocks an update.

A resumed session needs a terminal on every OS (with pipes the CLI falls
back to `--print` and exits): util-linux's or BSD `script`, or the holder.

### Automatic session recovery

A restart of the server ends every session it spawned, and those cannot be
picked up from claude.ai. So the session keeps the set of open sessions
(`claude-recovery.json`) and, after any start of the server it performs —
the restart verb, a new directory, the server dying, a reboot — and once
the server has registered again, resumes each that is not running, through
the ordinary resume verb with all its checks, newest first, at most 16.
Each attempt is a row of the roster's `actions`, and the report's
`recovered` holds the last run. A session the operator stopped is not
brought back (`src/claude/recovery.rs`).

### The claude a job runs, pinned

Where the `claude` a job runs is a nix store path (the box), the session
keeps it from the garbage collector while the job runs: a `gcroots/<job>`
link in its state directory, registered as an indirect root with
`nix-store --add-root` — something the operator's own user may do — and
removed once the job is gone (`src/claude/gcroot.rs`).

### The roster and the verbs

The session keeps a **roster** of every Claude Code session on the machine
(`src/claude/roster/`): the CLI's own `claude agents`, the transcripts
under `~/.claude/projects` (titles, counts and the last prompt, credential
shapes redacted — `src/claude/redact.rs`), the sessions it resumed, their
CPU and memory where the OS accounts for them, and the last 24 verb
outcomes; bounded to 512 KiB. It runs **three verbs** on one session
(`src/claude/sessions/`), each taking a selector and nothing else:
`resume <uuid>` (in the trusted project directory that holds its
transcript, refused when anything already runs it), `stop` (a session it
resumed, or a background agent) and `remove` (a background agent's
record). Every verb is refused while the policy keeps Claude off. A
development run with `DAEDALUS_AGENT_DATA_DIR` names its jobs apart, so it
never touches an installed agent's.

## Providers

`src/node/providers/` reads a model server on loopback every minute and
pushes the `providers` document up the link. Lemonade is the one kind.

- **Found by its install**, never by the app inventory
  (`os::lemonade::find`): on Windows the MSI's `Software\AMD\Lemonade
  Server` key in the console user's hive (per-user, the MSI's default) or
  HKLM (per-machine), and `LemonadeServer.exe`'s process, session and
  account; on macOS the pkg receipt and the `ai.lemonadeserver.server`
  LaunchDaemon; on Linux the package that owns `lemond.service`. The
  version is `/health`'s, never the installer's. A catalog that cannot be
  read is reported unknown (`models: null`), never empty.
- **`provider_install`** installs or updates to one release: only from
  `github.com/lemonade-sdk/lemonade/releases/download/<tag>/`, kept only at
  the size and SHA-256 the box sent, and refused while the policy pins
  another, while nobody is logged on (Windows), for another user's per-user
  install, or over a server no installer registered. A journal in
  `providers/lemonade-install.json` holds each step before it runs —
  download, graceful stop, silent install, `/health` at the target,
  `/internal/set` wiring (every address, the port, no broadcast, the
  origins the box names — kept on every read after, so a restart or a new
  origin is wired within a minute), the wanted power state — so a reboot resumes it; a failure reinstalls the
  installer the last good install kept (Windows uninstalls first: the MSI
  blocks a downgrade). Catalog ids gone after it are reported (`vanished`)
  with the installer log's tail. On Windows msiexec runs in the console
  user's session with their token, so the MSI's relaunch runs as them; a
  per-machine install runs as SYSTEM, and the server it relaunches outside
  the session is moved into it.
- **`provider_power`** starts or stops it — Windows: `LemonadeServer.exe
  --silent` in the user's session, `/internal/shutdown`; macOS: launchctl
  on the label; Linux: systemctl. The operator's word stands until the
  policy's `wanted` moves. A server seen running and then gone without the
  box asking (the tray's Quit) stays off until the next logon or an
  operator start (`manual_off`, kept across agent restarts, not reboots).
- **`always_on`** keeps the OS's own startup switch: Explorer's
  `StartupApproved\StartupFolder` value for the Startup shortcut, launchd's
  enable/disable, systemd's.

One verb runs at a time; each outcome is a row of the document's
`actions` under the controller's request id.

## Verbs

```
daedalus-agent install [--controller HOST:PORT] [--pin FINGERPRINT]
                                    register and start the service, the session and the tray (administrator / sudo);
                                    without --pin the machine runs unpaired. macOS: from inside Daedalus Agent.app,
                                    no --pin (the Mac logs in); --installer-uid UID, --replace-operator
daedalus-agent pair --pin FINGERPRINT [--controller HOST:PORT]
                                    trust that controller key (administrator / sudo); pair --check. Not on macOS
daedalus-agent enroll-finish CODE   (macOS, Linux) a log-in's last step, as root; the menu bar runs it
daedalus-agent uninstall [--app]    stop and remove them; macOS --app: log out and remove the app too
daedalus-agent run                  the service's entry point (the SCM, launchd, systemd — and nix for the controller)
daedalus-agent serve                the same in the foreground, in a terminal
daedalus-agent session              the Claude session without a tray: the Linux user unit
daedalus-agent status               the running agent's status document, through the local socket
daedalus-agent update [--apply]     check the release feed now; --apply installs, with the service stopped
daedalus-agent claude restart       ask the session to restart `claude remote-control`
daedalus-agent claude-holder "…"    (Windows) a resumed session's pseudo-console; the tray starts it
daedalus-agent root-helper --table FILE
                                    (the box) one connection to the root helper; its socket unit starts it
daedalus-agent outcome done|refused WORDS
                                    (the box) a root verb's unit says how its run ended
daedalus-agent version
```

An unknown verb prints the list and exits 2.

## On the machine

Windows:

```
C:\Program Files\daedalus-agent\daedalus-agent.exe        the service (.old / .new around an update, .bad after a rollback)
C:\Program Files\daedalus-agent\daedalus-agent-tray.exe   the tray, started at logon
C:\ProgramData\daedalus-agent\config.toml                 local knobs, never policy; edit and restart
C:\ProgramData\daedalus-agent\state.json                  the last update check and install, an update on probation, a version rolled back from
C:\ProgramData\daedalus-agent\identity.key                the machine's key
C:\ProgramData\daedalus-agent\policy.json                 the last policy the controller sent
C:\ProgramData\daedalus-agent\agent.lock                  held while the service runs: one per data directory
C:\ProgramData\daedalus-agent\providers\              a provider install's journal, its installers (the last good one kept), the user's manual-off
C:\ProgramData\daedalus-agent\logs\agent.log.*            the service's daily log
\\.\pipe\daedalus-agent                                   the local socket
%LOCALAPPDATA%\daedalus-agent\logs\                       the tray's and the session's logs, claude-rc.log, claude-session-<uuid>.log
%LOCALAPPDATA%\daedalus-agent\{jobs\,claude-recovery.json} each Claude job's record; the sessions to resume
```

macOS:

```
/Library/Application Support/daedalus-agent/Daedalus Agent.app   what launchd runs (root's): the service, linked from /usr/local/bin, and the menu bar app
/Library/Application Support/daedalus-agent/.update/             root's alone: stage/, old/ (until the new one proves itself), bad/
/Library/Application Support/daedalus-agent/{config.toml,state.json,identity.key,policy.json,installer.json,agent.lock,logs/}
/Library/Application Support/daedalus-agent/tunnel.toml          the log-in's WireGuard config (root's, 0600); absent: logged out
/Library/Application Support/daedalus-agent/run/{agent,santree}.sock
/Library/LaunchDaemons/me.toscanini.daedalus-agent.plist         the service's job
/Library/LaunchAgents/me.toscanini.daedalus-agent-tray.plist     the menu bar app's job
/Applications/Daedalus Agent.app                                 the user's copy: opening it starts the menu bar app, or installs
~/Library/Logs/daedalus-agent/                                   the menu bar app's and Claude's logs
~/Library/Application Support/daedalus-agent/{jobs/,claude-recovery.json}
```

Linux:

```
/opt/daedalus-agent/bin/daedalus-agent{,-tray}        the service (.old / .new / .bad as above) and, on x86_64, the tray
/var/lib/daedalus-agent/{config.toml,state.json,identity.key,policy.json,session.json,agent.lock,logs/}
/var/lib/daedalus-agent/run/{agent,santree}.sock
/etc/systemd/system/daedalus-agent.service            the service
/etc/systemd/user/daedalus-agent-session.service      the session, enabled for one user, lingering
/etc/xdg/autostart/daedalus-agent-tray.desktop        the tray, at every graphical login
~/.local/state/daedalus-agent/                        the session's and Claude's logs, claude-recovery.json, gcroots/
```

`data_dir` in config.toml moves state, identity and logs of an installed
agent. `DAEDALUS_AGENT_DATA_DIR` moves the whole directory, config.toml
included, for the process started with it alone — a `serve` and
development knob, which `install` and `uninstall` refuse; its Claude jobs
get names of their own.

### config.toml

`install` writes the first four keys (and `controller_address` and
`controller_pin` when `--controller` and `--pin` name them); every key is
optional, and a top-level key the agent does not know is ignored, so an
older install's file still starts the service. The header of
`src/core/config.rs` is the reference.

```toml
update_check_secs = 600   # how often the release feed is asked
log_level = "info"        # a tracing filter: "debug" for a bug report; one that is not a filter is refused
search_domains = []       # more domains to ask for _daedalus-controller._tcp
updates = "self"          # self | report: install a newer release, or only say one is available
# mode = "node"           # node | controller
# telemetry = "full"      # full | minimal | off
# data_dir = "…"
# controller_address = "…" # host:port; absent: DNS
# controller_pin = "…"     # the controller key's fingerprint; absent: unpaired
# app_url = "…"            # the app a Mac last logged in to
```

`minimal` telemetry is the machine and how it is doing — never the drives,
services, browsers, applications or pending updates; `off` reads nothing.
The providers are read at every level.

## How an update happens

Every ten minutes, and when the tray or the box asks, the agent lists the
repository's `agent-v<semver>` releases newer than its own, neither drafts
nor prereleases, and reads each one's `release.json`, newest first, until
one holds (`src/node/update/`): signed by a key in `RELEASE_PUBLIC_KEYS`
over a context of its own, its version its tag's, carrying this target's
required assets. Unless `updates = "report"`, `update::install` — the
updater's and `update --apply`'s one path — streams each asset beside the
binary as `.new`, keeps it only when size and SHA-256 are the manifest's,
records the probation in `state.json` (nothing is replaced when that
cannot be saved), renames the running binaries to `.old`, moves the new
ones in, and asks the new service binary its version: another version is
rolled back and refused. A swap that fails leaves no probation behind. The
service then exits 3, and its recovery action (`Restart=always`, launchd's
KeepAlive, the SCM's) starts the new binary, whose first start restarts the
tray or the session on it too. Claude keeps running in its jobs.

**On a Mac the release is the app.** Its one asset is unpacked into
`.update/stage`, made root's and fenced there — Apple's signature with the
team and fixed identifiers, the manifest's version, the staged service
answering with it — before the two bundles are exchanged in one rename
(`src/node/update/{bundle,slot}.rs`). The disk image is for people.

**Probation.** A signed binary is not trusted until it has run. Each start
of a version on probation under the service manager counts itself, before
config.toml is even read. It has proved itself once its local socket has
been served for two minutes and, when someone is logged on who runs a tray
or a session, that has reported; then the `.old` files are retired. A run
that has not within five minutes exits, a failed start; a version that
starts more than three times without proving itself is rolled back at its
next start — the `.old` binaries back, the failed ones `.bad`,
`rolled_back` in `state.json` — and never installed again; a newer release
is. While a version is on probation nothing newer goes over it, and
`update --apply` refuses while the service runs (its instance lock is
held), holding the lock itself while it installs.

## Versions

The version an agent reports names the build exactly. A release is the
crate's version alone (`0.25.0`), built by CI from the tag. Every other
build carries its source as semver build metadata: nix builds the
controller from the crate's own files and passes the start of their store
path's hash as `DAEDALUS_BUILD_ID`, so `build.rs` reports
`0.25.0+src.1a2b3c4d5e6f`, and an engine commit that leaves the crate alone
rebuilds nothing. The updater compares releases alone. Bump `Cargo.toml`
with every change under `agent/src` meant to ship.

## Releasing

Bump `version` in `Cargo.toml`, run `agent/gate.sh gen` (the app's
generated `constants.ts` carries the version) and `agent/gate.sh`, which also
moves `session-host/interop/Cargo.lock` to it; commit them all, tag
`agent-v<version>` on a commit on `main`, push the tag.
[`.github/workflows/agent.yml`](../.github/workflows/agent.yml) builds the
Windows binaries, Daedalus Agent.app (universal; zipped for the updater,
and the disk image), the static Linux service for x86_64 and aarch64 (musl,
rustls, no controller) and the x86_64 Linux tray, every build `--locked`;
writes `release.json`, signs it once with `AGENT_SIGNING_KEY` (the
`release` environment, the operator the required reviewer), checks the
signature against the compiled-in key, and publishes the release. The tag
and `Cargo.toml` must agree, and the commit must be on `main`.

A version whose `Cargo.toml` carries `[package.metadata.release] draft =
true` is published as a draft, which no agent is offered: try it, then
`gh release edit agent-v<version> -R santiagotoscanini/daedalus
--draft=false --latest`, and drop the table in the next bump.

The Mac's app is put together by [`macos/package.sh`](macos/package.sh),
codesigned (Developer ID, hardened runtime; identifiers
`me.toscanini.daedalus-agent` and `me.toscanini.daedalus-agent-tray`, fixed
for good), notarized and stapled, and checked as a Mac would; the secrets
are the `release` environment's `APPLE_*`. The PR check packages it signed
ad hoc and runs the menu bar app's smoke test.

The agent trusts every key in `RELEASE_PUBLIC_KEYS`: the current one and a
spare kept offline. Losing every listed private key strands every installed
agent on its version.

## Developing

[`gate.sh`](gate.sh) runs, in a throwaway rust container, fmt, clippy for
Linux with the tray and the controller, Linux as the static service is
built (neither), Windows (`x86_64-pc-windows-gnu`) and macOS
(`aarch64-apple-darwin`, with zig as ring's C compiler), the tests with the
controller's, and the static musl build: `agent/gate.sh
[fmt|check|test|musl|gen|all]`. The tests are platform-neutral — the OS
tools' parsers (`src/telemetry/parse/`), the DNS SRV codec, the units
`install` writes, every OS's Claude job as command lines — and what needs
the machine itself (the service, the power request, the tray, `install`,
launchd and the ConPTY) is compile-checked for each target, not run.

Nothing tests the target outside `src/os/`: one module per OS exporting the
same names, selected once in `src/os/mod.rs`. Commands whose output is
captured under a deadline go through `src/exec.rs`.

### The app's wire types

The app's TypeScript types for everything the controller's API answers,
takes and pushes are generated from the Rust types by
[ts-rs](https://github.com/Aleph-Alpha/ts-rs) into
`app/src/host/controller/generated/` (`src/ts.rs`, a test of the
controller's build, so no release binary carries it). The test fails when
the files there are not what the Rust generates now, and `agent/gate.sh gen`
writes them. The app's runtime decoders are held to the generated types at
compile time (`app/src/lib/contract/decode.ts`), so a change to a wire type
is the Rust, `gate.sh gen` and the app's typecheck, in one commit.
