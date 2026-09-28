# daedalus-agent

The box's presence on a machine it does not run: a Windows service, a
macOS launchd daemon or a Linux systemd service, with a tray / menu bar app
beside it where there is a desktop. It

- **holds the machine awake** while the box's policy says so — a Windows
  power request (`powercfg /requests`), a macOS IOKit assertion
  (`pmset -g assertions`) or a logind inhibitor on Linux
  (`systemd-inhibit --list`), plus, on Windows, the power plan's sleep and
  hibernate timers set to never;
- **keeps one connection to the controller**, the box's own agent, and
  talks to nothing else: TLS 1.3 with both keys pinned; hello, status,
  telemetry and the Claude report up; the box's policy and commands down
  at once (see "The link to the controller");
- **listens on nothing the LAN can reach**: its status page on port 7787
  (`port`) is bound to `127.0.0.1` — `/status`, the full Claude report at
  `/claude`, `/healthz`, and the tray's and session's writes, for this
  machine alone. Its metrics reach Prometheus through the controller
  (`/nodes/metrics`, below). `src/status.rs` has the routes;
- **reports the machine** — hardware, OS, usage, drives and their health,
  temperatures, network, battery, pending OS updates, installed browsers
  and applications. What is read, how often, and what stays off the status
  page: the header of `src/telemetry.rs`, and each OS's collector
  (`src/os/*/telemetry.rs`);
- **reads its providers and pushes them up** — a model server such as
  Lemonade, read on loopback every minute (every ten seconds while a
  download runs, and at once when the policy's port changes): whether it
  answers and calls itself healthy, its version, catalog (id, labels, on
  disk, size, recipe), what is loaded, downloads, installed backends and
  per-model figures from its `/metrics`, bounded, as the `providers`
  document. The box reads models and health from the controller
  (`nodes.providers`), never from the machine; only the gateway's model
  requests go to the machine directly. Read whatever the telemetry level;
  the box may set the port in the policy, `providers.lemonade.port`
  (`src/providers.rs`). It also runs the box's two residency verbs —
  load a model, put one down — on loopback when the controller asks
  (`provider_model`), and reports each outcome in the next document;
- **follows the box's policy** once an admin approves the machine on
  Settings › Machines — hold it awake or not, run Claude remote control or
  not and where, provider ports — and its commands: check for updates now,
  update Claude Code, restart Claude remote control. The last policy is
  kept in `policy.json` in the data directory, and the service and the
  session start from it, so a restart neither reverts Claude's directory
  or switch until the link answers nor restarts Claude twice (a fresh
  install starts from the defaults);
- **runs Claude Code's remote control** the way the box runs its own: the
  **session** — the process with the user's Claude login — supervises
  `claude remote-control --verbose`, restarts it with backoff, logs its
  output to `claude-rc.log`, and reports its state, versions, sessions and
  credential dates (never a token) to the service (`src/session.rs`,
  `src/claude/`). The server is never the session's child but a job of the
  OS — a systemd user unit, a launchd job, a detached process — so
  restarting, updating or quitting the agent ends no Claude session (see
  "Claude outside the agent"). On Windows and macOS the session lives in the
  tray, so nobody logged on means no server, and a machine that reboots
  unattended wants automatic sign-in. On Linux the session is a systemd user
  unit that runs with nobody logged in;
- **keeps the roster of Claude sessions** — every transcript, background
  agent and session it resumed — and runs the three verbs on one of them:
  resume, stop, remove, on every OS (see "Claude sessions: the roster and
  the verbs");
- **brings the sessions back** that a restart of the server ended — the
  restart verb, a new directory, the server dying, a reboot — by resuming
  each by itself once the server is up again (see "Automatic session
  recovery");
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
machines' links reach, and no link of its own, self-update, keep-awake,
tray or installer (`install` and `uninstall` refuse there).

## Controller mode

`mode = "controller"` is the agent on the box, as nix will run it: one
process as the operator (`daedalus-agent run` under systemd; `serve` is the
same in a terminal), with

- **the status page on every interface** (`0.0.0.0:7787`), for one reader:
  the box's Prometheus, whose container reaches the host through pasta's
  host alias, so its connections arrive at the host's LAN address rather
  than loopback. Other addresses get `GET /healthz` and
  `GET /nodes/metrics` alone and 403 for everything else; the host
  firewall keeps the port closed to the LAN (nix). A node binds loopback;
- **telemetry** at the level `telemetry` sets (below);
- **the session inside the process**: Claude remote control as its
  transient user unit, reported straight into the service. `daedalus-agent
  session` refuses in this mode. Its log is `claude-rc.log` in the data
  directory's `logs/`; its recovery set (`claude-recovery.json`) and the
  gcroots of the `claude` its units run (`gcroots/`) are in the data
  directory itself. The unit outlives the agent, as on a node: a stop
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
- **`GET /nodes/metrics`**, the one endpoint Prometheus scrapes for every
  machine: each connected, approved machine's telemetry as Prometheus text
  (`src/telemetry/metrics.rs`), and `daedalus_agent_link_up` (1 while
  connected) per approved machine. Every series carries four labels:
  `node` (the node id), `host` (its hostname) and `os` (`windows`,
  `macos`, `linux`) from its hello, and `machine` — the name the app
  hands over in `nodes.set_desired`, or the hostname when it sends none.
  Each connected machine's Claude series ride beside its telemetry —
  `daedalus_agent_claude_up` (1 while `running`, 0 otherwise, with the
  report's `state` as a label, `none` without a report — `off` whenever the
  policy does not want Claude there, installed or not, and `not-installed`
  only where it is wanted and there is no `claude`),
  `daedalus_agent_claude_restarts_total` and `daedalus_agent_claude_sessions`
  — and so do the CONTROLLER's own, labelled as a machine of its own
  (`node` its node id, `host` and `machine` its hostname), so one alert
  (`daedalus_agent_claude_up == 0` with `state!="off"`) covers the box and
  every machine. A connected machine's providers ride there too:
  `daedalus_agent_provider_up` (1 while it answers and calls itself
  healthy; `kind`, `port`, `version` and `offered` — "1" when the app
  offers it to the gateway — as labels), which the "Model Server Down"
  alert reads, and `daedalus_agent_provider_{models,loaded}` (on disk,
  resident). The box's telemetry is not in it: node-exporter covers
  the box;
- and nothing else: no link of its own, no self-update, no keep-awake, no
  tray, no installer, and no `claude update` — nix pins Claude Code on the
  box (`POST /claude/update` answers 403 there).

With no controller above it there is no policy from the box, so nix writes
the controller's own in config.toml:

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
- The status page's `port` kept CLOSED to the LAN: it binds every
  interface so the Prometheus container can reach `/nodes/metrics`, and
  only the firewall stops the LAN from asking the same.
- A `claude_unit` distinct from any unit the box already runs, and
  `nix-store` on the service's PATH: the agent pins the `claude` each of
  its units runs itself (see "The claude a job runs, pinned"), so the unit
  needs no root `ExecStartPre` for it.

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
← {"id":1,"ok":{"api":1,"version":"0.18.0","mode":"controller","hostname":"s2-server","capabilities":["claude.remote_control","claude.sessions","telemetry.full"]}}
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
| `claude.roster`    | `{reporting, roster}`: the session's roster of Claude sessions, or `reporting: false` | `claude.sessions` |
| `claude.session` `{action, id}` | `{queued: true, request}`: one verb — `resume`, `stop`, `remove` — for the session; its roster's `actions` reports the outcome under `request` | `claude.sessions` |
| `telemetry.get`    | `{level, telemetry}`: the document at the configured level           | —                       |
| `events.subscribe` | `{}`, then the events below                                          | —                       |
| `nodes.list`       | `{nodes: [{id, fingerprint, state, connected, since, last_seen, hostname, os, arch, agent_version, lan_ip, mac, claude}]}`: every machine known | `nodes` |
| `nodes.get` `{id}` | the same fields, plus `public_key`, the whole `hello`, `status` (the machine's status page without its telemetry) and `status_at`, `telemetry` (the open page's view) and `telemetry_at`, `providers` and `providers_at` (null until the machine pushed one) | `nodes` |
| `nodes.telemetry` `{id}` | `{id, telemetry, received_at}`: the full document at the machine's level | `nodes` |
| `nodes.providers` `{id}` | `{id, connected, providers, received_at}`: the providers document as the machine last pushed it, null until it has (providers.rs) | `nodes` |
| `nodes.claude` `{id}` | `{id, report, received_at}`: the machine's full Claude report      | `nodes`                 |
| `nodes.claude_roster` `{id}` | `{id, roster, received_at}`: the machine's roster of Claude sessions | `nodes`      |
| `nodes.claude_session` `{id, action, session}` | `{delivered: true, request}`: one verb on one of the machine's sessions, acknowledged by it; its roster reports the outcome under `request` | `nodes` |
| `nodes.provider_model` `{id, kind, action, model, pinned?, replacing?}` | `{delivered: true, request}`: one residency verb (`load` or `unload`; a load may put `replacing` down first) on one model of the machine's provider, acknowledged at once and run on the machine's loopback; its providers document reports the outcome under `request` (`actions`). Needs `providers.residency`; never queued | `nodes` |
| `nodes.set_desired` `{nodes: [{id, public_key, state, policy, name}]}` | `{nodes, approved, revoked, pending, policy}`: the ids whose open connection was upgraded, revoked and closed, sent back to pending, or sent a changed policy | `nodes` |
| `nodes.command` `{id, command}` | `{delivered, queued}`: acknowledged by the connected machine, or kept for its next connection | `nodes` |

`state` is `pending` (connected, not decided), `approved`, `revoked` or
`unknown` (seen, not decided, gone). `nodes.set_desired` is the app's
COMPLETE set of decided keys — `state` `approved` or `revoked`, `policy`
the link's `Policy` (`src/link/wire.rs`: `awake_hold`, `claude_remote_control`,
`claude_workdir`, `providers.lemonade.port`, plus `providers.lemonade.offer`, which the controller keeps for `/nodes/metrics` and does not pass on; absent for an approved key:
the defaults), `name` what the pages call the machine (optional; the
`machine` label in `/nodes/metrics`, the hostname when absent) — idempotent, applied as a difference to the connections open
now; a key left out is pending while connected. Every entry is checked
before any applies: `id` must be the node id of `public_key`, no id twice,
no field the controller does not know, a `name` not blank, at most 64
characters, without control characters. `command` is one of `check_update`,
`claude_update`, `claude_restart`; a machine never heard of is `not_found`,
one not approved `unavailable`; one that does not acknowledge within 5 s
is `unavailable` too. Every `id` is sixteen lowercase hex characters,
checked before anything else. A session verb's selector is checked as
strictly — a canonical lowercase uuid for `resume`, that or a background
agent's eight hex digits for `stop`, the eight digits for `remove` — here,
again by the machine, and again by its session; `nodes.claude_session`
reaches only a connected, approved machine that offers `claude.sessions`
(`unsupported` otherwise), is refused by one whose policy keeps Claude off,
and is never queued for later. All of this is additive to api 1.

Capabilities come from the role table and the config, never from the OS:
`claude.remote_control` where a session runs and may run Claude — on the
controller only while `[controller] claude_remote_control` is on — and
`claude.sessions` beside it;
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
tests pinning each one's exact JSON; `src/api/mod.rs` the rules above. The
app's TypeScript types for all of it are generated from these Rust types
(see "The app's wire types").

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
config.toml's `controller_address` (`install --controller`); else the one a
first-use key was trusted at, kept in `controller.json` in the data
directory; else the SRV record `_daedalus-controller._tcp` under the
search domains DHCP handed out (and `search_domains`). With none, the
machine reaches nobody, says so, and asks again every minute. The key:
config.toml's `controller_pin` (`install --pin`), which nothing overrides;
else the first key the controller presents — trust on first use — kept in
`controller.json` and never re-pinned. DNS only ever names an address.

A controller that presents another key than the trusted one is refused,
and the page and the tray say **controller key changed**, with the key
trusted and the one that came — labelled unproven, since the pin check
runs before the handshake signature. If the controller really has a new
key, pin it (`install --pin`) or remove `controller.json`. (Rotating the
controller's key through a signed statement is a later feature.)

**Pinned or not.** A key trusted on first use works like a pinned one, but
the status page's `controller.unconfirmed` is true and the tray says
"trusted on first use, UNCONFIRMED: pin it" with its amber dot, until a
`controller_pin` names it.

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
hostname, MAC, LAN address, facts, capabilities,
telemetry level; its key is the certificate's), then, once approved,
`status` (the status page without its telemetry: the awake hold, updates,
policy, Claude summary, the link itself) on change and every minute,
`telemetry` (the whole document at the machine's level) when a sample
carries newly read static or slow facts or OS updates and otherwise every
minute, `claude` (the full report) on change and every minute,
`claude_roster` (the roster of Claude sessions, at most 512 KiB) on change
— its clock and its ticking costs aside — and every minute, and
`providers` (the providers document, at most 4 providers of 256 models each, refused past its bounds) on change — its clocks aside — and every minute. Controller → machine: `state`, `policy`, `command`
requests (`check_update`, `claude_update`, `claude_restart`),
`claude_session` requests (`{action, id, request}`: one verb on one
session, under the request id the controller minted) and `provider_model`
requests (`{kind, action, model, pinned, replacing, request}`), each
acknowledged at once; a session verb's outcome rides the next roster, a
residency verb's the next providers document.

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
app hands the desired set back. Label values in `/nodes/metrics` are
escaped, newlines included, and stripped of other control characters; the
name in `nodes.set_desired` is refused when blank, longer than 64
characters or holding a control character.

The status page's `controller` block and the tray's menu show the link:
the address and where it came from, the state (`connecting`, `pending`,
`approved`, `revoked`, `refused`, `key-changed`), both fingerprints, how
the controller's key is trusted (`config` or `tofu`) and the last error.

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
starts it as the desktop user, writes `config.toml` if there is none, and
starts the service. It opens nothing in the firewall: the agent listens on
nothing the LAN can reach. Re-running replaces the binaries and keeps the
config. `daedalus-agent uninstall` removes the service and the tray's Run
key; the data directory stays.

Without parameters the machine finds the controller through DNS and trusts
its key on first use. To name the controller and pin its key at install,
run the script as a script block so it takes parameters:

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
`daedalus-agent` into `/usr/local/bin`. Nothing is registered with the
application firewall: the agent listens on nothing the LAN can reach.
`sudo daedalus-agent uninstall` removes both jobs.

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
- writes `config.toml` if there is none. Nothing needs opening in a
  firewall: the status page answers loopback alone, and the link is
  outbound.

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

## Claude outside the agent

Claude remote control and every session the agent resumed run as **jobs of
the OS**, never as children of the agent: the session starts each one,
watches it, stops it, and when the session itself restarts — an agent
update, a crash, the tray quit and started again — it finds the job still
running by its name and re-attaches. So updating or restarting the agent
never ends a Claude session, on any OS. Each job's output is appended to a
log of its own (`claude-rc.log`, `claude-session-<uuid>.log`), which the
report's `log` names and which the session reads the server's banner back
from, after the marker line it writes before each start.
`src/claude/job.rs` has what a job is and the pure command lines;
`src/os/*/jobs.rs` the calls.

- **Linux and the controller: a transient systemd user unit.** The server
  is `daedalus-claude-rc.service` (`systemd-run --user`), watched with
  `systemctl --user show`, stopped with `systemctl --user stop` — the whole
  cgroup, the sessions it spawned with it — and kept with its exit status
  (`RemainAfterExit=yes`) until the session has read it. A resumed session
  is `claude-session-<uuid>.service`, under util-linux's `script -qfec`.
- **macOS: a launchd job in the user's `gui/<uid>` domain.** The session
  writes the job's plist into its own state directory —
  `~/Library/Application Support/daedalus-agent/jobs/me.toscanini.daedalus-agent.<job>.plist`,
  never `~/Library/LaunchAgents`, so no login starts it by itself — and
  bootstraps it (`launchctl bootstrap gui/<uid>`): `RunAtLoad`, no
  `KeepAlive` (the supervisor decides what runs again), its output appended
  to the log. `launchctl print` watches it, read by its braces rather than
  its indentation; a print the agent cannot read is "unknown", never
  "gone" — only launchctl's "Could not find service" (exit 113) is — and an
  unknown state is asked again, never answered by a new start that would
  boot out a live server. A job that exited stays loaded with its exit code
  until `launchctl bootout` clears it, which also ends its process group; a
  start waits (up to 5 s) for launchd to let the label go before it
  bootstraps it again. launchd hands a job the system's PATH, so the session's
  own goes along with Homebrew's two prefixes after it. A resumed session is
  the BSD `script -q /dev/null <command…>` (a command as words, no `-c`)
  piped through `sed -l` and `grep --line-buffered`, the same filter as on
  Linux. `sudo daedalus-agent uninstall` boots the server's job out of the
  console user's domain; sessions it resumed run until they end or the user
  logs out.
- **Windows: a process detached from the tray.** Started with
  `CREATE_NO_WINDOW` (a hidden console its children inherit, so the shells
  it runs flash no window), `CREATE_NEW_PROCESS_GROUP` and
  `CREATE_BREAKAWAY_FROM_JOB` (outside any job object the tray is in; tried
  again without where the job forbids it — then the log warns and the
  report's `detail` says "not broken away from the tray's job"), its stdout
  and stderr the log file. Windows does not end a process with its parent,
  so that is all "detached" takes. The session records each job — pid AND
  creation time — in `%LOCALAPPDATA%\daedalus-agent\jobs\<job>.json`, so a
  new tray finds it again and never adopts a later process that got the
  same pid; a process whose record cannot be written is ended at once and
  the start reported failed, so no unrecorded Remote Control runs beside the
  next. A stop is `taskkill /PID … /T /F`, the whole tree, and
  `daedalus-agent uninstall` stops every user's recorded jobs. A resumed
  session needs a terminal, and on Windows that is a pseudo-console: its job
  is this agent's own binary in **holder mode** — `claude-holder "<command
  line>"`, never run by hand — which creates a ConPTY
  (`CreatePseudoConsole`), starts `claude --resume <uuid> --remote-control
  <hostname>` in it with the console, not the holder's own handles, as its
  standard handles (`STARTF_USESTDHANDLES` with none), a `.cmd` shim through
  `cmd.exe /d /s /c`, drains what it shows into the log with escapes
  stripped and the status box dropped, and leaves with the CLI's exit code
  (`src/os/windows/holder.rs`). The holder, not the tray, owns the terminal,
  so the session survives the tray. It runs from a per-version copy,
  `%LOCALAPPDATA%\daedalus-agent\holder\daedalus-agent-<version>.exe` (older
  versions' copies deleted once nothing runs them), never from the installed
  binary, so a long session never stops an update from replacing it; an
  `.old` binary still in use is moved aside to `.old.<n>` and retired at a
  later start.

`claude_rc` is gone from config.toml (0.17.0): there is no child strategy
left to choose, and a config that still names it reads as if it did not.

The logs are rotated while their job runs, once they pass 20 MiB, and it
has to be done without a rename: the job's output was opened once, to
append, and a renamed file would go on growing under its new name. It is
copied to `<log>.1` (one old file, replaced each time) and truncated in
place, and the next write lands at the new end (`src/claude/logs.rs`; a line
written between the copy and the truncation is in neither). A resumed
session's log is removed two weeks after its job is gone.

### Automatic session recovery

A restart of the server ends every session it spawned, and those cannot be
picked up from claude.ai, only resumed here. So the session keeps the set of
sessions that are **open** — each live session file whose process descends
from the server's (the ones it spawned), and each session this agent
resumed that runs as its own job — on every look, written to
`claude-recovery.json` in the session's state directory (the data directory
on the controller). After ANY start of the server the agent performs — the
restart verb, a new working directory from the policy, the server dying and
the supervisor starting it again, the machine coming back from a reboot, an
agent start that found no server running — and once the server has
registered again (its environment id printed, or 30 s up), it resumes each
session of the set that is not running, by id, through the ordinary resume
verb with all its checks (transcript, trusted directory, nothing already
running it), the most recently opened first, at most 16. A re-attach ends
nothing and recovers nothing; `claude update` restarts nothing, so it
recovers nothing either.

Each attempt is a row of the roster's `actions` (`resume`, its detail
opening "recovery after a Remote Control restart: …"), and the Claude
report's `recovered` holds the last run: `[{id, result, detail, at}]`,
`result` one of `done`, `refused`, `failed`. A session leaves the set when
it has not been open for 30 s while the same server kept running (ended
from claude.ai, or it left on its own), or at once when the operator stops
it (the `stop` verb): a session somebody stopped is not brought back.
Nothing leaves the set while the server is down or a recovery is due or
running; a session whose resume failed drops out after the grace — one
attempt per restart.

### The claude a job runs, pinned

Where the `claude` a job runs is a nix store path (the box, and any machine
whose Claude Code nix installed), the session keeps it from the garbage
collector while the job runs: a rebuild can leave the server or a resumed
session running a `claude` no generation names any more. When it starts a
job — and when it re-attaches to one, read off the unit's ExecStart or the
plist, so a job an earlier agent started is protected too — it links `gcroots/<job>` in its state directory to that store path and
registers the link as an indirect root with `nix-store --add-root … --realise`
— something the operator's own user may do (the daemon records it under
`/nix/var/nix/gcroots/auto/`; `/nix/var/nix/gcroots/per-user/` is root's and
need not exist). A link whose job is gone is removed within a minute, and
the next collection forgets it (`src/claude/gcroot.rs`). Elsewhere nothing
is pinned.

## Claude sessions: the roster and the verbs

The session (the process with the user's Claude login) keeps a **roster**
of every Claude Code session on the machine and runs **three verbs** on
one of them, on every OS, on a thread of its own so a scan or a resume
never holds up the tray. The API has them as `claude.roster` and
`claude.session` on the controller, `nodes.claude_roster` and
`nodes.claude_session` for the other machines, all behind the
`claude.sessions` capability, offered wherever Claude may run.

**The roster** (`src/claude/roster.rs`), read every minute and right after
a verb, pushed to the controller when it changes:

- `agents` — `claude agents --json`, the CLI's own view, field by field:
  authoritative for what is alive, the only source for background agents;
  `agents_available` false when the CLI did not answer. An agent's
  `detail` and `needs` are session content and never read.
- `transcripts` — the `<uuid>.jsonl` files under `~/.claude/projects/<slug>/`
  (regular files in real directories, never a link), the newest 200 that
  are not empty, with `transcript_total` and `empty_count`: each with its
  project, cwd (exact from its head, or un-slugged), title (the operator's,
  the sidecar's, the model's; 160 characters), start and last write, size,
  and `meta` — what one pass over the file counted (exchanges typed,
  replies, thinking blocks, images, attachments, sidechain records, the span
  it was open across, branch, CLI version, the CLI's cost totals) and the
  last prompt typed: one line, credential shapes redacted, cut to 160
  characters (`src/claude/redact.rs`; best effort — a secret with no shape
  stays). A scan is kept by size and mtime, so the steady state reads only
  the file being typed into.
- `managed` — the sessions this agent resumed, running now, with their
  job, pid, log, and memory and CPU where the OS accounts for them (a
  systemd unit; null on macOS and Windows).
- `session_stats` — per live session file whose process is still the one
  that wrote it: CPU, resident memory, the Remote Control bridge's debug
  log size and mtime. Linux reads /proc; on Windows and macOS the list is
  empty and `errors` says so.
- `server` — the Remote Control job's memory and CPU, where the OS keeps
  them (a systemd unit's); null elsewhere.
- `actions` — the last 24 verb requests, the operator's and the automatic
  recovery's, and how each ended (`running`, `done`, `refused`, `failed`,
  with a sentence of the agent's own; what the CLI printed goes to the
  agent's log alone).

Bounded: 200 transcripts and agents, strings cut, the whole at most
512 KiB (the oldest transcripts go first, and `truncated` says so).

**The verbs** (`src/claude/sessions.rs`) take a selector and nothing else —
never a path, a flag or a directory:

- `resume <uuid>` runs `claude --resume <uuid> --remote-control <hostname>`
  as a job of its own, `claude-session-<uuid>`, under a terminal (with
  pipes the CLI falls back to `--print` and exits: `script` on Linux and
  macOS, the holder's pseudo-console on Windows — "Claude outside the
  agent") with its output filtered into `claude-session-<uuid>.log` beside
  `claude-rc.log` (ANSI stripped, the status box's repaint dropped). A
  restart or an update of the agent ends nothing, and the next start lists
  it in `managed` again. It needs the transcript as a regular file under
  `~/.claude/projects`, runs only in the trusted project directory whose
  slug holds it (anywhere else it would stop on the trust prompt with
  nobody to answer), with the Remote Control job's environment plus TERM
  (and `/run/wrappers/bin`, sudo, on NixOS), and is refused when anything
  already runs that session — its job, the CLI's agents, a live session
  file — or when `claude agents` does not answer. Five seconds after the
  start the job must still run.
- `stop <uuid>` stops a session this agent resumed (its job: the whole
  tree); a Remote Control session has no stop of its own. A stopped
  session leaves the recovery set. `stop <8 hex>` is `claude stop` for a
  running background agent, settled by no process being left behind it.
- `remove <8 hex>` is `claude rm` for a background agent's record (and its
  worktree), settled by the record being gone; never `--discard-unpushed`.

Every verb is refused while the machine's policy (the controller's
config.toml) keeps Claude off. A development run with
`DAEDALUS_AGENT_DATA_DIR` names its jobs `daedalus-claude-rc-<hash>` and
`claude-session-<hash>-<uuid>`, so it never lists or stops an installed
agent's.


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
the machine can read the full Claude report at `127.0.0.1:7787/claude`,
ask for a Claude restart, post a roster in place of the session's, and — by
posting a report of its own — take the session verb requests the box sent
before the session does (it cannot make one: those come only from the
controller) — worth knowing on a Linux machine several people log in to.

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
daedalus-agent claude-holder "…"    (Windows) a resumed session's pseudo-console; the tray starts it, never by hand
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
C:\ProgramData\daedalus-agent\controller.json             the controller key trusted on first use, and its address (the link)
C:\ProgramData\daedalus-agent\policy.json                 the last policy the controller sent, what a restart starts from
C:\ProgramData\daedalus-agent\logs\agent.log.*            daily-rotated log
C:\ProgramData\daedalus-agent\logs\claude-rc.log          what `claude remote-control` printed
C:\ProgramData\daedalus-agent\logs\claude-session-<uuid>.log  what a resumed session showed (the holder's log)
%LOCALAPPDATA%\daedalus-agent\jobs\<job>.json             each Claude job's pid and creation time, to re-attach by
%LOCALAPPDATA%\daedalus-agent\claude-recovery.json        the sessions to resume after a Remote Control restart
```

macOS:

```
/Library/Application Support/daedalus-agent/bin/daedalus-agent        the service (.old / .new around an update)
/Library/Application Support/daedalus-agent/bin/daedalus-agent-tray   the menu bar app
/Library/Application Support/daedalus-agent/{config.toml,state.json,identity.key,controller.json,logs/}
/Library/LaunchDaemons/me.toscanini.daedalus-agent.plist              the service's job
/Library/LaunchAgents/me.toscanini.daedalus-agent-tray.plist          the menu bar app's job
~/Library/Logs/daedalus-agent/                                        the menu bar app's logs (claude-rc.log, claude-session-<uuid>.log)
~/Library/Application Support/daedalus-agent/jobs/*.plist             the Claude jobs' plists (never in ~/Library/LaunchAgents)
~/Library/Application Support/daedalus-agent/claude-recovery.json     the sessions to resume after a Remote Control restart
gui/<uid>/me.toscanini.daedalus-agent.daedalus-claude-rc              Claude remote control's job, while it is loaded
gui/<uid>/me.toscanini.daedalus-agent.claude-session-<uuid>           a session the agent resumed
```

Linux:

```
/opt/daedalus-agent/bin/daedalus-agent                the service (.old / .new around an update); /usr/local/bin links to it
/opt/daedalus-agent/bin/daedalus-agent-tray           the tray, x86_64 desktops only
/var/lib/daedalus-agent/{config.toml,state.json,identity.key,controller.json,policy.json,session.json,logs/}
/etc/systemd/system/daedalus-agent.service            the service's unit
/etc/systemd/user/daedalus-agent-session.service      the session's unit, enabled for one user, lingering
/etc/xdg/autostart/daedalus-agent-tray.desktop        the tray, at every graphical login
~/.local/state/daedalus-agent/                        the session's and the tray's logs: session.log.*, claude-rc.log,
                                                      claude-session-<uuid>.log (a resumed session's); claude-recovery.json
                                                      (the sessions to resume) and gcroots/ (nix machines)
daedalus-claude-rc.service (transient, user)          Claude remote control, while it runs
claude-session-<uuid>.service (transient, user)       a session the agent resumed, while it runs
```

(`$XDG_STATE_HOME/daedalus-agent` when that is set.) To run `serve` or
`session` as an ordinary user without installing, set
`DAEDALUS_AGENT_DATA_DIR` to a directory that user owns: the logs, the
session's included, go there — its state too — and the Claude jobs get
names of their own (`daedalus-claude-rc-<hash of the directory>`,
`claude-session-<hash>-<uuid>`), so a development run never touches an
installed agent's server or sessions.

`data_dir` in config.toml moves state, identity and logs of an installed
agent; config.toml stays where it is. `DAEDALUS_AGENT_DATA_DIR` moves the
whole directory, config.toml included, and wins over `data_dir` — but only
for the process started with it, so it is a `serve` and development knob:
the service, the tray and `sudo` never see it, and `install` and
`uninstall` refuse to run while it is set. Both must be absolute paths; a
relative one stops the agent at start with a message saying so.

### config.toml

`install` writes the first five keys, and `controller_address` and
`controller_pin` when `--controller` and `--pin` name them; every key is
optional, and a top-level key the agent does not know is ignored. The
header of [`src/config.rs`](src/config.rs) is the reference.

```toml
port = 7787               # the status page's port, on loopback (all interfaces on the controller)
update_check_secs = 600   # how often the release feed is asked
auto_update = true        # the older spelling of `updates`
log_level = "info"        # "debug" for a bug report
search_domains = []       # more domains to ask for _daedalus-controller._tcp
# mode = "node"           # node | controller (see "Controller mode")
# telemetry = "full"      # full | minimal | off
# updates = "self"        # self | staged | external
# data_dir = "…"          # see above
# controller_address = "…" # the controller's link address, host:port; absent: DNS
# controller_pin = "…"     # its key's fingerprint; absent: trust on first use
```

`telemetry = "full"` reads everything above; `minimal` reads the machine
and how it is doing — make, model, firmware, OS, processor, memory,
volumes, GPUs, temperatures, network, battery, the process count,
and what could not be read — and never reads the drives
(serials, SMART), services, browsers, installed applications or pending OS
updates; processes are sampled for the count, but the list is not
reported; `off` reads nothing (the page's `telemetry` is null, and
`/nodes/metrics` carries no telemetry series for it). The providers are
read at every level (an installed but stopped Lemonade is found through
the application list, which only `full` reads).

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
(the Linux session unit by leaving, for systemd to start it again). Claude
keeps running in its jobs on every OS and is re-attached; the next clean start deletes
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
development packages: `agent/gate.sh [fmt|check|test|musl|gen|all]`. The macOS
check needs no Apple toolchain because TLS there comes from the OS through
native-tls; Linux uses rustls over the system's CA bundle (Mozilla's roots,
compiled in, only when the system has none), so no OpenSSL is linked
anywhere. The tests
are platform-neutral — the parsers of Windows' SMBIOS table, of macOS's
tools and of Linux's `/proc`, `/sys` and package managers included, which
live outside the per-OS code (`src/telemetry/parse/`), the DNS SRV codec
(`src/dns.rs`), the systemd units `install` writes (as golden text), and
every OS's Claude job — the systemd arguments, the launchd plist and its
BSD `script` line, `launchctl print`/`list` and `ps` parsing, the Windows
job record, command-line quoting and the holder's terminal filter
(`src/claude/job.rs`) — and the service, the power request, the tray,
`install`, and the Claude jobs themselves on macOS (launchd) and Windows
(the detached process, the ConPTY holder) are exercised on the machines
themselves: here they are compile-checked by clippy for both targets, not
run.

### The app's wire types

The app's TypeScript types for everything the controller's API answers,
takes and pushes — and the documents inside: the Claude report and roster,
the telemetry, a machine's hello and status page — are generated from the
Rust types by [ts-rs](https://github.com/Aleph-Alpha/ts-rs) into
`app/src/host/controller/generated/`, one file per type and an `index.ts`
(`src/ts.rs`; the serde attributes decide the shape: `rename_all`,
`flatten`, `skip_serializing_if` for an optional key; a u64 is a `number`).
It is a test, and ts-rs a dev-dependency, so no release binary carries it.
The test fails when the files there are not what the Rust generates now —
in the gate (which mounts that directory into its container) and in CI's
`cargo test` — and `agent/gate.sh gen` writes them. The app keeps its
runtime decoders, each held to its generated type at compile time
(`reads<T>()` in `app/src/lib/contract/decode.ts`): a field the Rust side
renames, drops or makes nullable, or a word it adds to an enum, fails the
app's typecheck. So a change to a wire type is: the Rust, `gate.sh gen`, the
app's typecheck, one commit with all three.

Everything that differs by OS is behind `src/os/`: one module per OS
(`windows/`, `macos/`, `linux/`) exporting the same names, selected once
in `src/os/mod.rs`, so an OS that lacks one is a compile error. Commands
whose output is captured under a deadline — PowerShell, Apple's tools, the
Linux tools, `claude --version` and `claude update` — go through one helper,
`src/exec.rs`; macOS's `launchctl_timeout` (`src/os/macos/launchd.rs`) keeps
its own.
