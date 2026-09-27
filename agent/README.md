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
- **keeps one connection to the controller**, the box's own agent: TLS 1.3
  with both keys pinned, hello, status, telemetry and the Claude report up,
  the box's policy and commands down at once. Until the controller has
  approved the machine the hello above goes on beside it; then the hello
  pauses (see "The link to the controller");
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
status page, telemetry and the session, the local API and the listener the
machines' links reach, and no hello, self-update, keep-awake, tray or
installer (`install` and `uninstall` refuse there).

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
- **its own identity key**, made on first start as a node's is
  (`identity.key` in its data directory, 0600): what every machine pins.
  `system.info` states it (`controller.public_key`, `.fingerprint`);
- **the listener for the machines' links**, where `[controller] listen`
  names an address (absent: none — the box opens no port until nix says
  so), and the registry of machines the API's `nodes.*` methods read
  (see "The link to the controller");
- **`GET /nodes/metrics`** on the loopback status page: every connected
  machine's telemetry as Prometheus text, the series and labels each
  machine's own `/metrics` writes plus `node="<id>"`, and
  `daedalus_agent_link_up` per approved machine — so Prometheus can scrape
  the controller instead of every machine. The page stays on loopback; how
  Prometheus reaches it is nix's to decide;
- and nothing else: no hello, no self-update, no keep-awake, no tray, no
  installer, and no `claude update` — nix pins Claude Code on the box
  (`POST /claude/update` answers 403 there).

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
listen = "0.0.0.0:7788"                 # the machines' links; absent: no listener
advertise = ["s2-server.lan:7788"]      # what machines should dial (one or a list), for the app
```

The table's values are checked only in controller mode (`api_socket` and
`claude_workdir` absolute, `claude_unit` a plain unit name, no root in
`api_allowed_uids`, `listen` an address and port, `advertise` host:port
pairs), but a key it does not know is an error in every mode, so a typo in
what nix writes fails loudly. A controller never holds the machine awake.

What the unit nix writes should carry:

- `Restart=always`. The agent is built with `panic = "abort"`, so a panic
  in any thread — the session's included — ends the whole process;
  systemd brings it back, and the Claude unit, which outlives it, is
  re-attached.
- A `LimitNOFILE` with room: each API connection is a few threads and
  two descriptors, up to 16 at once, and each machine's link a thread and
  a descriptor, up to 64, beside the telemetry and the session's tools.
- With `listen` set, the port open to the LAN in the firewall (and only
  there: the link is for machines on the network).
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
`bad_request`. A method's own parameters are exact. The methods — fixed
verbs, none taking a command, a path or a flag:

| method             | answers                                                              | needs                   |
|--------------------|----------------------------------------------------------------------|-------------------------|
| `system.info`      | version, mode, api, hostname, OS facts, uptimes, the role table, capabilities, and on the controller `controller: {public_key, fingerprint, listen, advertise}` | — |
| `claude.status`    | `{reporting, wanted, report}`: the session's last report, or `reporting: false` | `claude.remote_control` |
| `claude.restart`   | `{queued: true}`; the session restarts the server at once (`unavailable` while no session reports) | `claude.remote_control` |
| `claude.update`    | `{queued: true}`; never offered on the controller                    | `claude.update`         |
| `telemetry.get`    | `{level, telemetry}`: the document at the configured level           | —                       |
| `events.subscribe` | `{}`, then the events below                                          | —                       |
| `nodes.list`       | `{nodes: [{id, fingerprint, state, connected, since, last_seen, hostname, os, arch, agent_version, lan_ip, mac, claude}]}`: every machine known | `nodes` |
| `nodes.get` `{id}` | the same fields, plus `public_key`, the whole `hello`, `status` (the machine's status page without its telemetry) and `status_at`, `telemetry` (the open page's view) and `telemetry_at`, `providers` | `nodes` |
| `nodes.telemetry` `{id}` | `{id, telemetry, received_at}`: the full document at the machine's level | `nodes` |
| `nodes.claude` `{id}` | `{id, report, received_at}`: the machine's full Claude report      | `nodes`                 |
| `nodes.set_desired` `{nodes: [{id, public_key, state, policy}]}` | `{nodes, approved, revoked, pending, policy}`: the ids whose open connection was upgraded, revoked and closed, sent back to pending, or sent a changed policy | `nodes` |
| `nodes.command` `{id, command}` | `{delivered, queued}`: acknowledged by the connected machine, or kept for its next connection | `nodes` |

`state` is `pending` (connected, not decided), `approved`, `revoked` or
`unknown` (seen, not decided, gone). `nodes.set_desired` is the app's
COMPLETE set of decided keys — `state` `approved` or `revoked`, `policy`
the `Policy` of the hello answer (`awake_hold`, `claude_remote_control`,
`claude_workdir`, `providers.lemonade.port`; absent for an approved key:
the defaults) — idempotent, applied as a difference to the connections open
now; a key left out is pending while connected. Every entry is checked
before any applies: `id` must be the node id of `public_key`, no id twice,
no field the controller does not know. `command` is one of `check_update`,
`claude_update`, `claude_restart`; a machine never heard of is `not_found`,
one not approved `unavailable`; one that does not acknowledge within 5 s
is `unavailable` too. Every `id` is sixteen lowercase hex characters,
checked before anything else. All of this is additive to api 1.

Capabilities come from the role table and the config, never from the OS:
`claude.remote_control` where a session runs and may run Claude — on the
controller only while `[controller] claude_remote_control` is on;
`claude.update` where the agent may update Claude Code (a node's role, not
the controller's); `telemetry.full` or `telemetry.minimal`; `nodes` where
the controller listens for machines. A method whose capability is absent
answers `unsupported`. The events: `claude.changed` `{reporting, state,
pid}` when a session starts reporting, when its state or pid moves, and
when it stops reporting for 30 s (`reporting: false`, state and pid null);
`telemetry.updated` `{sampled_at}` with every sample; `nodes.changed`
`{id, state, connected}` when a machine connects, leaves or changes
standing; `nodes.pending` `{id, fingerprint, hostname}` when an unknown key
connects and waits. Events are best effort: a subscriber whose queue fills
loses events, not its connection (one that stops reading altogether is
closed by the write timeout). `src/api/wire.rs` has every type and golden
tests pinning each one's exact JSON; `src/api/mod.rs` the rules above.

## The link to the controller

Every machine keeps ONE outbound connection to the controller, and only
the controller talks to the app (over the socket above): a star with the
box at the centre. The link carries control messages — who a machine is,
how it is, what it runs, and the box's word back — never data-plane
traffic. `src/link/` has it all; its `mod.rs` header is the reference.

**Transport.** TLS 1.3 over TCP on every OS, through rustls with pure-Rust
primitives the agent plugs in itself (`src/link/crypto.rs`: X25519,
ChaCha20-Poly1305, SHA-256, ed25519 — so no C crypto library is built for
any target; a test runs it against rustls' ring provider on Linux). Both
ends present a self-signed certificate made from their ed25519 identity
key and sign the handshake with it; there is no CA and no hostname. A
machine accepts the controller only if the SHA-256 of its key matches the
pin; the controller accepts any machine's key at the TLS layer and decides
right after whether it is approved, pending or revoked. Lines are
newline-delimited JSON with the local API's envelope, at most 1 MiB; the
link protocol's version rides the first request. Heartbeats both ways
every 15 s; 45 s of silence ends the connection; a machine reconnects with
backoff from 1 s to 30 s.

**Fingerprints.** A key is shown as the SHA-256 of its public key in
lowercase hex, four characters to a group: `3f2a:9c01:…` (sixteen groups).
A machine's node id is the first sixteen hex characters of the same
digest. The machine's status page and tray show its own and the
controller's; `system.info` shows the controller's.

**Where the machine connects, and whom it trusts.** The address:
config.toml's `controller_address`; else the one kept in `controller.json`
in the data directory (the box's word, or the first key trusted); else the
SRV record `_daedalus-controller._tcp` under the search domains the
`_daedalus._tcp` record is looked for in. The key, strongest first:

1. config.toml's `controller_pin` (`install --pin`), which nothing
   overrides;
2. the key the box names in its answer to the legacy hello — but only as
   far as that answer can be believed. It is AUTHENTICATED only when the
   box's address is the operator's own (`control_plane_url` in config.toml)
   and the request and the final answer (redirects followed) are both
   HTTPS. A box found through the SRV record counts as a first use at best:
   anyone who can answer DNS on the LAN could point the record at themselves.
   A plain-HTTP answer's hint is ignored outright;
3. the first key the controller presents — trust on first use.

A hint records a key only where none is trusted; an authenticated hint
naming the key already trusted on first use CONFIRMS it. No hint ever
replaces a trusted key: another key is shown on the status page and in the
tray as a conflict for the operator, and nothing changes. A controller that
presents another key than the trusted one is refused, and the page and the
tray say **controller key changed**, with the key trusted and the one that
came — labelled unproven, since the pin check runs before the handshake
signature. If the controller really has a new key, pin it (`install --pin`)
or remove `controller.json`. (Rotating the controller's key through a
signed statement is a later feature.)

**Confirmed or not.** A key pinned by config or confirmed by an
authenticated hint is confirmed. A key trusted on first use is not: the
status page's `controller.unconfirmed` is true, and the tray says "trusted on
first use, UNCONFIRMED: pin it" with its amber dot. The link works either
way, but only a confirmed controller stands in for the legacy hello.

**Files that hold trust.** `identity.key` and `controller.json` are read
only when their owner is trusted: SYSTEM or Administrators on Windows, root
or the agent's own user elsewhere; one that is not is refused (the link
says so and does not fall back to a first use). On Windows `install` gives
the data directory a protected DACL — SYSTEM and Administrators full
control, Users read and execute, and Modify on `logs\` alone, where the tray
writes — and cuts inheritance from ProgramData.

**Enrollment.** A key the app has not approved is held PENDING: the
controller lists it (`nodes.list`, `nodes.pending`) and keeps nothing it
pushes; the machine shows "waiting for approval" with both fingerprints so
the operator can compare them before approving on Settings › Machines.
When the app's set approves the key, the controller upgrades the open
connection — no reconnect — and sends the policy. A revoked key is told so
and disconnected; the machine says "revoked" and tries again at the
slowest step. A decision is for a key: a connection whose key is not the
one the app decided for that id is refused.

**Messages.** Machine → controller: `hello` (agent version, OS, arch,
hostname, MAC, LAN address, the status port, facts, capabilities,
telemetry level; its key is the certificate's), then, once approved,
`status` (the status page without its telemetry: the awake hold, updates,
policy, Claude summary, the link itself) on change and every minute,
`telemetry` (the whole document at the machine's level) when a sample
carries newly read static or slow facts or OS updates and otherwise every
minute, `claude` (the full report) on change and every minute, and
`providers` on change. Controller → machine: `state`, `policy`, and
`command` requests (`check_update`, `claude_update`, `claude_restart`),
each acknowledged at once.

**Limits.** Before a key is admitted a connection holds one of 32 pre-auth
slots (3 per address; an IPv6 /64 is one address) and has 5 s in all for
the handshake and a `hello` of at most 16 KiB, whose fields are bounded
(hostname at most 253 bytes without control characters; OS, arch, version
and each of at most 32 capabilities short tokens; facts at most 256 bytes;
MAC and LAN address parsed strictly) — anything else is refused. Admitted,
it holds one of 64 connections. Unknown keys: at most 10 a minute per
address, judged after the handshake, so an approved machine is never refused
for its address; at most 16 pending in all and 2 per address, each
connection pending for at most an hour (the machine reconnects and waits
again); when the 64 are taken, an approved key takes the oldest pending
one's place. Of an unknown key that left only its id, fingerprint, hostname
and last-seen time are kept, at most 256 such keys, and at most 1024
addresses are counted. The controller keeps what it observed in memory
only; after a restart the machines reconnect and fill it again, and the
app hands the desired set back. Label values in `/nodes/metrics` (and a
machine's own `/metrics`) are escaped, newlines included, and stripped of
other control characters.

**Migration.** A machine with the link keeps the legacy hello to the app
going until the controller approves it AND its key is confirmed; from then
on the hello pauses, and resumes if the link stays down for five minutes or
the machine is revoked or sent back to pending, so a controller that went
away does not take the machine off the box's pages. A machine with no
controller address and no SRV record stays on the legacy hello exactly as
before, and learns the controller from the hello's answer once the app
adds `controller: {address, public_key}` to it — which is how machines
enrolled before the link move to it without enrolling again (as a first use
unless their box address is `control_plane_url`, see above). The LAN status
page and its token-gated reads are unchanged in this step. The status page's
`controller` block and the tray's menu say which path the machine uses:
`legacy`, `both`, or `controller`.

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

To name the controller and pin its key at install, run the script as a
script block so it takes parameters:

```powershell
& ([scriptblock]::Create((irm https://daedalus.toscanini.me/install.ps1))) -Controller s2-server.lan:7788 -Pin 3f2a:9c01:…
```

On a Mac or a Linux machine, from a terminal, as the user whose Claude Code
should run there (`sh -s -- --controller HOST:PORT --pin FINGERPRINT` to
name the controller and pin its key; both optional, the one-liner below
unchanged without them):

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

Re-running either script replaces the binaries and keeps the config —
except `controller_address` and `controller_pin`, which `--controller` and
`--pin` (`-Controller`, `-Pin`) set in a config that exists too. The
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
daedalus-agent install [--port N] [--controller HOST:PORT] [--pin FINGERPRINT]
                                    register and start the service, the session and the tray (administrator / sudo);
                                    --controller and --pin name the controller and pin its key in config.toml
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
C:\ProgramData\daedalus-agent\controller.json             the controller key this machine trusts, and its address (the link)
C:\ProgramData\daedalus-agent\logs\agent.log.*            daily-rotated log
C:\ProgramData\daedalus-agent\logs\claude-rc.log          what `claude remote-control` printed
```

macOS:

```
/Library/Application Support/daedalus-agent/bin/daedalus-agent        the service (.old / .new around an update)
/Library/Application Support/daedalus-agent/bin/daedalus-agent-tray   the menu bar app
/Library/Application Support/daedalus-agent/{config.toml,state.json,identity.key,controller.json,logs/}
/Library/LaunchDaemons/me.toscanini.daedalus-agent.plist              the service's job
/Library/LaunchAgents/me.toscanini.daedalus-agent-tray.plist          the menu bar app's job
~/Library/Logs/daedalus-agent/                                        the menu bar app's logs (claude-rc.log)
```

Linux:

```
/opt/daedalus-agent/bin/daedalus-agent                the service (.old / .new around an update); /usr/local/bin links to it
/opt/daedalus-agent/bin/daedalus-agent-tray           the tray, x86_64 desktops only
/var/lib/daedalus-agent/{config.toml,state.json,identity.key,controller.json,session.json,logs/}
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
# controller_address = "…" # the controller's link address, host:port; `install --controller` writes it
# controller_pin = "…"     # its key's fingerprint; `install --pin` writes it
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
