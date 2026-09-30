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
- **listens on nothing, loopback included**: the tray, the session and the
  verbs reach the service through a local socket that knows who is calling
  — a unix socket on macOS and Linux, a named pipe on Windows — and serves
  only root (SYSTEM) and the user the machine runs Claude for (see "The
  local socket"). Its metrics reach Prometheus through the controller
  (`/nodes/metrics`, below);
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
  the state in its tooltip and menu, and the actions: show the status
  document (written to `status.json` in its log directory and opened),
  check for updates, restart Claude remote control, open the logs, open
  Claude's log;
- **updates itself** to the newest `agent-v*` release of this repository,
  verifying every asset against the ed25519 key compiled into it, and goes
  back to the previous binaries when a new one does not prove itself (see
  "How an update happens").

## Node and controller

`mode` in config.toml says what the agent is, and `src/role.rs` holds the
one table of what runs for each: a **node** — every machine that joins the
network — runs all of the above; the **controller** — the box itself, NixOS
by definition, the same Linux code built and configured by nix — runs the
local socket, the metrics page, telemetry and the session, the local API and the listener the
machines' links reach, and no link of its own, self-update, keep-awake,
tray or installer (`install` and `uninstall` refuse there).

## Controller mode

`mode = "controller"` is the agent on the box, as nix will run it: one
process as the operator (`daedalus-agent run` under systemd; `serve` is the
same in a terminal), with

- **the metrics page on every interface** (`0.0.0.0:7787`, `port`), for
  one reader: the box's Prometheus, whose container reaches the host
  through pasta's host alias, so its connections arrive at the host's LAN
  address rather than loopback. It answers `GET /healthz` and
  `GET /nodes/metrics` and 404 for everything else — the status document
  is the local socket's — and the host firewall keeps the port closed to
  the LAN (nix). A node has no page at all;
- **the local socket** (see "The local socket"), serving the operator and
  root: `daedalus-agent status` on the box;
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
  `system.info` states it (`controller.public_key`, `.fingerprint`), and
  `controller.rotate` hands its trust to a new one (see "Rotating the
  controller's key");
- **the listener for the machines' links**, where `[controller] listen`
  names an address (absent: none — the box opens no port until nix says
  so), and the registry of machines the API's `nodes.*` methods read
  (see "The link to the controller");
- **the session host's two files**, where `[controller.session_host]`
  names them: the allow-list it writes from the app's decisions and the
  status file it reads every 2 s (see "The session host");
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

[controller.session_host]               # absent: this box runs no session host
address = "box.example.org:7789"        # where machines dial it, handed to santree machines
allow_list = "/srv/state/controller/session-host-allow.json"  # written here, read by the host
status_file = "/srv/state/session-host/status.json"          # written by the host, read here
bin = "/nix/store/…-daedalus-session-host-0.1.0/bin/daedalus-session-host"  # the installed build
config = "/nix/store/…-daedalus-session-host.json"                          # the installed config
```

The table's values are checked only in controller mode (`api_socket` and
`claude_workdir` absolute, `claude_unit` a plain unit name, no root in
`api_allowed_uids`, `listen` an address and port, `advertise` host:port
pairs, `[controller.session_host]` all four keys, its address host:port
and its paths absolute), but a key it does not know is an error in every
mode, so a typo in what nix writes fails loudly. A controller never holds
the machine awake.

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
- The metrics page's `port` kept CLOSED to the LAN: it binds every
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
| `system.info`      | version, mode, api, hostname, OS facts, uptimes, the role table, capabilities, and on the controller `controller: {public_key, fingerprint, listen, advertise, rotation}` — `rotation` null, or the rotation under way: `{from_public_key, from_fingerprint, started_at, retires_at, old_key_connections}` | — |
| `controller.rotate` `{grace_secs?}` | the same `controller` block: a new controller key made, the old one retired after `grace_secs` (60 s to 90 days; absent, 7 days); `unavailable` while one runs | the controller |
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
| `root.run` `{verb, selectors?}` | `{run, verb, outcome, detail, verbs?}`: one of the root helper's verbs run to its end (`done`, `refused` with the unit's reason, `failed`); `status` answers every verb and its unit's state in `verbs`. Answers when the unit has finished, so a client gives it its own timeout; its unit's lines go out as `root.progress` meanwhile ("The root helper", below) | `root` |
| `santree.status` | `{state, version, restart_pending, live_ptys, connections: [{node, name, count}], error}`: the session host from its status file — `state` `running`, `stale` (not written for 30 s), `stopped` or `missing`; `restart_pending` when the running build or config is not the installed one; `error` why the file could not be read, why the allow-list could not be written (revocations are not reaching the host; retried every 2 s), or why the host is not using it as written. `unavailable` where `[controller.session_host]` names none ("The session host") | — |

`state` is `pending` (connected, not decided), `approved`, `revoked` or
`unknown` (seen, not decided, gone). `nodes.set_desired` is the app's
COMPLETE set of decided keys — `state` `approved` or `revoked`, `policy`
the link's `Policy` (`src/link/wire.rs`: `awake_hold`, `claude_remote_control`,
`claude_workdir`, `providers.lemonade.port`, `santree` (absent: off), plus `providers.lemonade.offer`, which the controller keeps for `/nodes/metrics` and does not pass on — and never `session_host`, which is the controller's to fill; absent for an approved key:
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
the controller listens for machines; `root` on the controller while
`[controller] root_socket` names the root helper. A method whose
capability is absent answers `unsupported`. The events: `claude.changed` `{reporting, state,
pid}` when a session starts reporting, when its state or pid moves, and
when it stops reporting for 30 s (`reporting: false`, state and pid null);
`telemetry.updated` `{sampled_at}` with every sample; `nodes.changed`
`{id, state, connected}` when a machine connects, leaves or changes
standing; `nodes.pending` `{id, fingerprint, hostname}` when an unknown key
connects and waits; `root.progress` `{run, verb, line}` for each line a
running root verb's unit writes. Events are best effort: a subscriber whose queue fills
loses events, not its connection (one that stops reading altogether is
closed by the write timeout). `src/api/wire.rs` has every type and golden
tests pinning each one's exact JSON; `src/api/mod.rs` the rules above. The
app's TypeScript types for all of it are generated from these Rust types
(see "The app's wire types").

### The root helper

The controller runs as the operator and holds no privilege. What only root
may do on the box reaches it through a systemd-owned socket
(`daedalus-root.socket`, the operator's and 0600, `Accept=yes`): each
connection starts a fresh, sandboxed root process, `daedalus-agent
root-helper --table FILE` (`src/root/`), which checks the peer is the
table's one uid (`SO_PEERCRED`; root itself is refused), reads one request
line `{verb, id, selectors}`, and answers. No root process stays resident.

The table is nix's (`fleet.daedalus.rootVerbs` in
`nix/stacks/daedalus/controller.nix`): each verb an existing oneshot unit
and its selectors, each a fixed list of values spliced into the unit name
as `{name}`; nothing from the caller becomes a path, a flag or a unit name.
A verb runs as `systemctl start <unit>`, so the work is the unit's and
survives a restart of its caller; the unit's journal lines stream back as
`{"t":"progress","line":…}`, then one `{"t":"result","outcome":…,
"detail":…}`: `failed` when the start job failed, else `done` — or
`refused` when the unit's last line is `refused: <reason>` (it exits 0, so
no failed unit; systemd forgets a oneshot's exit status once it is
inactive, so the journal carries the word). A unit
already running is refused, never joined. A request the table does not
allow gets `{"t":"error","code":…,"msg":…}`. `status` is the helper's own
read: every verb and its unit's state. Only the controller connects: the
app asks `root.run`.

## The link to the controller

Every machine keeps ONE outbound connection to the controller, and only
the controller talks to the app (over the socket above): a star with the
box at the centre. The link carries control messages — who a machine is,
how it is, what it runs, and the box's word back — never data-plane
traffic. `src/link/` has it all; its `mod.rs` header is the reference.

**Transport.** TLS 1.3 over TCP on every OS, through rustls with pure-Rust
primitives the agent plugs in itself (`src/link/crypto.rs`: X25519,
ChaCha20-Poly1305, SHA-256, ed25519 — so the link builds no C crypto
library; a test runs it against rustls' ring provider on Linux). The
tunnel's boringtun brings ring on macOS and Linux; Windows builds no C
crypto at all, and the gate checks it. Both
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
config.toml's `controller_address` (`install --controller`); else the SRV
record `_daedalus-controller._tcp` under the search domains DHCP handed out
(and `search_domains`), the record chosen by priority then weight on every
OS. With neither, the machine reaches nobody, says so, and asks again
every minute. The key: config.toml's `controller_pin`, which `install
--pin` or `pair` writes (on a Mac, a log-in) and nothing else supplies — no key is trusted on
first use. A machine without a pin is **unpaired**: it resolves no address
and dials nobody, and its page and tray say `unpaired` until it is paired
(see "Install"). It is re-pinned only by a rotation the trusted key signed (below). DNS only ever
names an address.

A controller that presents another key than the trusted one is refused,
and the page and the tray say **controller key changed**, with the key
trusted and the one that came — labelled unproven, since the pin check
runs before the handshake signature. If the controller really has a new
key outside a rotation, pin it (`pair --pin`).

**Rotating the controller's key** (`src/link/rotation.rs`).
`controller.rotate` makes a new identity beside the old one
(`identity.next.key`), signs with the OLD key the statement that the new
key succeeds it — ed25519 over a context of its own, the old key and the
new — and records both with the end of a grace period in `rotation.json`
(both 0600 in the controller's data directory, each written whole or not
at all). While both exist the listener presents each machine the key it
pins: a machine names that key in the TLS server name (`k<its node
id>.daedalus-controller`), so one that
re-pinned is served the new key and every other the old one — chosen once,
in the connection's handshake, from the keys as they stood when it was
accepted, so a retirement mid-handshake cannot mislabel it. Every
connection under the old key is sent the statement once (`rotate
{new_public_key, signature}`); the machine checks it against the key its
handshake just proved — never against anything the request carries —
re-pins config.toml's `controller_pin` (rewritten in place with every other
line, comment and table kept, and atomically), acknowledges, and reconnects under the new key; its page's
`controller.rotated` says from which key to which, and when. A statement
another key signed is refused and nothing moves; an impostor, which cannot
finish the handshake with the pinned key, never gets as far as sending
one. `system.info`'s `controller` names the new key from the start (what
an install should pin) and, under `rotation`, the old one, when it retires
and how many machines still connect under it.

When the grace period ends — wall-clock time: a clock set ahead retires
early, one set back late, a controller down past it retires at its next
start — the new key becomes `identity.key` and the old one is gone. A
machine that did not connect in the meantime, or an agent older than
0.19.0 (which ignores the statement), is left pinning a key the controller
no longer has, and is pinned again by hand. A half-done rotation heals and
never stops the controller: a next key whose record is missing, torn or
does not verify is signed again (the same deterministic signature); a
record whose key is already `identity.key` was a retirement that stopped
half-way and goes; anything unreadable is logged and the current key
served alone.

What rotation is not: a way out of a compromised key. The old key's holder
signs the statement, so whoever holds a leaked controller key can sign one
for a key of their own, and every machine that meets them first follows
it. A leaked key is recovered from by pinning a new one by hand
(`pair --pin`) on every machine.

**Files that hold trust.** `identity.key`, `config.toml` (which names the
controller) and `policy.json` are read only when their owner is trusted:
SYSTEM or Administrators on Windows, root or the agent's own user
elsewhere; one that is not is refused, and `install` refuses a data
directory or config someone else made. Every file the agent writes is
written whole or not at all, to a temporary that did not exist before —
never through a planted link — then renamed (`util::write_atomic`). The key
is its owner's alone: 0600 on unix, where a key readable by others is
refused; on Windows an explicit protected DACL, SYSTEM and Administrators
only, set as the file is created. On Windows `install` gives the data
directory a protected DACL — SYSTEM and Administrators full control, Users
read and execute (the tray reads the kept policy) — cutting inheritance
from ProgramData; the key, `config.toml`, `agent.lock` and the service's
`logs\` are SYSTEM's and Administrators' alone, re-applied at every start
of the service, which also removes what a user left in `logs\`. The tray
and the session log under the user's own `%LOCALAPPDATA%`.

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
`providers` (the providers document, at most 4 providers of 256 models each, refused past its bounds) on change — its clocks aside — and every minute. Controller → machine: `state`, `policy`
(`{awake_hold, claude_remote_control, claude_workdir?, providers?, santree?,
session_host?}`: `santree` the app's toggle, `session_host` —
`{address, public_key}` — filled by the controller only while it is on;
kept in `policy.json`, and a revoked machine, or one paired with another
box, drops the two), `command`
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

The status document's `controller` block and the tray's menu show the link:
the address and where it came from, the state (`connecting`, `pending`,
`approved`, `revoked`, `refused`, `key-changed`), both fingerprints, how
the controller's key is pinned (always `config`), the last rotation
(`rotated`) and the last error.

## Logging in (macOS)

A Mac does not pair: it **logs in**, from the menu bar's "Log in…", and
gets a WireGuard tunnel of its own to the box — an ordinary client of the
box's wg-easy — through which alone it reaches the controller's link and
the session host, at home or away. A Mac with a pin but no tunnel config is
logged out, and dials nobody. `src/enroll.rs`'s header is the reference for
the flow and who may run each step; `src/tunnel/mod.rs`'s for the tunnel.

1. "Log in…" asks for the app's address (`https://host[:port]`, the last
   one offered), and the service answers with the Mac's key, fingerprint
   and a PKCE challenge (`enroll.begin`); the verifier stays in the
   service's memory.
2. The browser opens the app's enroll page with those, a loopback port and
   a `state`; the menu shows the fingerprint to check. The operator signs
   in (Pocket ID), types the fingerprint's first four characters and
   confirms — or declines, and nothing changes.
3. On confirm the app approves the node, makes its wg-easy client, and
   sends the browser to `http://127.0.0.1:<port>/callback` with a
   single-use code. The menu bar asks for an administrator's password once
   and runs `daedalus-agent enroll-finish CODE` as root: the service
   redeems the code with its verifier (`POST /api/agent/enroll`), keeps the
   client config in `tunnel.toml` (0600, root's) and the pin, the
   controller's in-tunnel address and the app's address in config.toml,
   brings the tunnel up and links through it.

"Log out" tells the controller (`leave` on the link; the app deletes the
wg-easy client) and forgets the log-in: pin and address out of
config.toml, the tunnel down, `tunnel.toml` and the kept policy deleted. A
Mac the box revokes forgets its log-in the same way. The menu and the
status page show the tunnel (`link.tunnel`): up or down, the last
handshake's age, the endpoint, and why it is down.

**The tunnel** runs in the service: boringtun (the WireGuard protocol,
sans-IO) and smoltcp (TCP) on one thread — no utun device, no route,
nothing of it reaches the Mac's own network stack. It reaches one address,
the box's (its AllowedIPs, one /32), and dials nothing else; its UDP
socket is unconnected, so it follows the Mac from network to network, and
an unanswered handshake has the endpoint's name resolved again. MTU 1280,
so it fits inside another WireGuard (the system VPN) too.

Linux builds the same code, so the tests and `e2e-tunnel.sh` (the tunnel
against a real wg-easy, its API driven as the app drives it) run there, but
its tray pairs; Windows pairs and builds none of it.

## The local socket

The tray, the session and the verbs (`daedalus-agent status`, `claude
restart`) reach the service through one local socket, and nothing else
listens on a node — not even on loopback (`src/local.rs`). On macOS and
Linux it is `run/agent.sock` in the data directory, in a directory the
service makes 0711 (root's on a node, the operator's on the controller)
with the socket 0666: every local user may reach it, and the kernel's word
on the peer (`SO_PEERCRED` on Linux, `getpeereid` on macOS) is the gate. On
Windows it is the named pipe `\\.\pipe\daedalus-agent`, whose DACL grants
SYSTEM and the pipe's owner full control and the interactive users read and
write-data — never the right to create an instance, so nobody can stand a
second server up beside the service — and which refuses remote clients.
The service reads the request first, then takes the client's user from its
own token while impersonating it (`ImpersonateNamedPipeClient`, at the
identification level the client opens with) — never by opening its
process, so a reused pid cannot pass for it. A development run
(`DAEDALUS_AGENT_DATA_DIR`) gets a pipe of its own.

**Who is served**, and nobody else: root (SYSTEM on Windows), the service's
own user, and the users the machine runs Claude for —

- Linux: the session user `install` recorded (`session.json`);
- macOS: the user at the console, the owner of `/dev/console` (another
  user's menu bar app, under fast user switching, is refused);
- Windows: the user of every session someone is logged on to, at the
  console or remotely, active or disconnected — each runs a tray.

Anyone else gets one `forbidden` line and a closed connection, and the
service logs the uid or SID. The client checks the other end too, by what
it can see without opening the service's process (a user's tray cannot
open a SYSTEM process): on unix the socket's server is root or the
client's own user (the controller's operator, a development run) and owns
the socket file; on Windows the pipe object's owner is SYSTEM or
Administrators and its server runs in session 0 — or, in a development run
alone, the pipe is the client's own. So a pipe squatted while the service
is down cannot give the session orders.

One request per connection, one JSON line each way (at most 1 MiB), in the
agent's one envelope (`src/rpc.rs`, the API's and the link's too), 16
connections at once. The whole exchange has a deadline on both ends, however
slowly the other end drips its bytes and whether or not it reads: fifteen
seconds on the service's side (room for a log-in's redeem at the app),
two on the client's (the tray asks from its UI thread; a log-in's steps wait
the service's fifteen, from threads of their own) — a watchdog tears the
connection down when it passes, the same on every OS (`src/door.rs`). The status
document never waits on the OS: its power requests (`powercfg` on Windows)
are read by the service every minute on a thread of their own.
`{"id":1,"m":"<method>","p":…}` → `{"id":1,"ok":…}` or
`{"id":1,"err":{"code","msg"}}`. The methods:
`status` (the status document), `claude` (the session's full report),
`claude.report` (the session's poll: its report in, the `ReportAnswer`
out), `claude.roster`, `claude.restart`, `claude.update` (refused on the
controller, where nix pins Claude Code), `update.check` and `link.reload`
("Pairing" below), and on macOS and Linux a log-in's three (see "Logging
in (macOS)"): `enroll.begin` and `enroll.leave` for the operator, as
santree's socket admits them (`os::operator_allowed`), and `enroll.finish`
for root alone. There is no pairing method: naming the controller is an
administrator's, never a socket user's — which is why a log-in's last step
runs as root. A socket that cannot be made does not stop the service: it is
tried again every 15 s.

The tray, the session and the service are one binary, so the envelope
moves with a release: the new service restarts the others on the new
binary at its first start (see "How an update happens"), and a Linux tray
whose service stops answering after its binary was replaced leaves for the
new one.

## The santree socket

[santree](https://github.com/santree-ai/santree) opens its projects on the
box through the agent on its own machine (`src/santree.rs`). santree
connects to a local socket; for each connection the agent opens a TLS 1.3
connection of its own to the box's session host (`session-host/` in this
repository), proving this machine's node key and pinning the host's, and
pipes the bytes both ways. It never reads santree's protocol, and the link
to the controller carries none of it.

- **Where**: `run/santree.sock` in the data directory, beside
  `agent.sock` — `/Library/Application Support/daedalus-agent/run/santree.sock`,
  `/var/lib/daedalus-agent/run/santree.sock` — on macOS and Linux (no door
  on Windows yet). A socket that cannot be made never stops the service; it
  is tried again every 15 s.
- **Who**: root, the service's own uid, and the user who installed the
  agent — recorded by `install` from `sudo` (`installer.json` on macOS,
  `session.json` on Linux) — and nobody else. Not the console user: a
  connection here is a shell as the operator on the box (who has NOPASSWD
  sudo), so it must not follow whoever sits at the machine; another account
  gets `forbidden`. With no user recorded — a Mac that updated itself from
  before 0.22, since only `install` records one — the operator is refused
  too, and the `forbidden` line says so and to run `sudo daedalus-agent
  install` from their account. Every process of that user may use it, as they may use
  that user's ssh keys. The socket is 0666 in the service's 0711 `run/`,
  the kernel's peer check the gate; santree checks the other end is root's.
- **The first line** is the agent's, in its envelope, before santree writes
  anything:
  `{"id":null,"ok":{"host":"<host:port>","node":"<node id>","agent":"<version>"}}`,
  then raw bytes both ways; or `{"id":null,"err":{"code","msg"}}` and a
  closed socket — `santree_off` (the policy keeps it off: Settings ›
  Machines), `host_key_changed` (the host proved another key than the box
  named), `unavailable` with the reason (not paired, not approved, no session
  host named, not reachable, TLS failed). The door's own `forbidden` and
  `busy` (past four connections at once, the host's per-machine cap) come
  the same way. The checks read the kept policy, so a controller restart
  does not stop santree; the host's allow-list is what admits the key, and
  its refusal — which TLS 1.3 delivers after the handshake — is the stream
  ending after `ok`, logged as such.
- **The dial**: every address the name resolves to, then the handshake, in
  one 10 s deadline, on the agent's own TLS provider (link/crypto.rs; the
  host runs ring's, and `session-host/interop` proves the two meet).
- **The pipe**: two threads over one TLS connection, records sealed and
  sent in order, no lock held across a read. A santree that stops reading
  stalls the host, which drops the link and parks its sessions (santree
  re-attaches losslessly); a write either way blocked for 30 s, or a host
  silent for 60 s (it pings every 15), ends the pipe. santree's end is
  passed on as close_notify and a half-close, the host's close_notify as
  santree's end of stream; anything else tears both down.
- **The log**: one line as a connection opens or is refused (the peer's
  uid and pid, the host, the code), one as it ends (how long, bytes each
  way, who ended it). Never a byte of what it carried.

A machine learns where the host is from its policy (see "The link to the
controller"): `santree`, the app's toggle, and `session_host`, which the
controller fills from the host's status file for approved machines with
santree on. Both are kept in `policy.json`; a revoked machine, or one
paired with another box, drops them.

### The session host

On the controller, `[controller.session_host]` names the host's files
(`src/session_host.rs`; nix writes the table from `session-host.nix`):

- **the allow-list** it writes — `{"schemaVersion":1,"nodes":[{"id","publicKey"}]}`,
  the app's approved machines with santree on, sorted — from every
  `nodes.set_desired`, before that set's policy events go out; atomically,
  0600, as the controller's user (the host's), only when it changes, one set
  at a time. Never before the first set after a start: the registry is empty
  until the app pushes, and writing that would cut every terminal across a
  controller restart. So a revocation made while the controller is down, or
  while it refuses the app's set, reaches the host with the next set it
  takes. The set applies to the links regardless of the write, so a write
  that fails must not leave a revoked machine admitted: when the file there
  admits anyone the new set does not (or cannot be read), it is removed —
  the host reads a missing file as nobody, and an unlink needs no free
  space — while a failed write that only adds machines leaves it be (it
  revokes nothing; removing it would cut every terminal). The set is then
  written again every 2 s until a write succeeds, and `santree.status` says
  revocations are not reaching the host meanwhile. An unchanged file is left
  alone only when it is a regular 0600 file of this user, as the host needs;
- **the status file** it reads every 2 s (the host rewrites it at least
  every 10 s) — only a regular file, root's or its own, writable by nobody
  else, at most 1 MiB, read leniently: its key goes to every santree machine
  with its policy (a new key at once), and `santree.status` answers from it —
  `stale` when a running host has not written it for 30 s, `restart_pending`
  when its `exe` is not `bin` or its `config` not `config` (the installed
  build and config file; nix writes a changed config to a new store path),
  and the host's own word that it is not using the allow-list as written
  (`allowList.error`) in `error`.

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

Every file is checked against the release's manifest (`release.json`) by
SHA-256; the manifest's signature is the agent's to check on every later
update (PowerShell has no ed25519), so at install the trust is HTTPS to
GitHub.

On a Mac or a Linux machine, from a terminal, as the user whose Claude Code
should run there:

```sh
curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh
```

It checks every file against the release's manifest by SHA-256, and the
manifest's signature against the release key where the machine's openssl
can check ed25519 (OpenSSL 3; not macOS's LibreSSL, where the trust at
install is HTTPS to GitHub).

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
  firewall: nothing listens, and the link is
  outbound.

`sudo daedalus-agent uninstall` stops and removes the service, the session
and the tray's entry, stops the Claude server, and turns lingering off
again if `install` turned it on (`session.json` in the data directory
records who and whether); the binaries, config and identity stay.

Re-running either script replaces the binaries and keeps the config —
except `controller_address` and `controller_pin`, which `--controller` and
`--pin` (`-Controller`, `-Pin`) set in a config that exists too. The
site serves both scripts from `main`, so neither command names a version.
Neither installs a release older than 0.21.0 (`MIN_VERSION`), newest or
named: older agents trusted the first controller that answered — and on a
Mac nothing older than 0.23.0, which paired instead of logging in.
Trust at install is HTTPS to GitHub; every update after that is verified by
the agent against the release key it carries.

### Pairing

Windows and Linux pair; a Mac logs in instead (see "Logging in (macOS)"):
`install` there takes no `--pin` or `--controller`, `pair` refuses, and the
menu bar offers "Log in…" where the tray elsewhere offers "Pair with the
box…". Install first, pair after. A machine installed without a pin is
**unpaired**: the service, session and tray run, but it trusts no
controller and dials nobody — nothing is trusted on first use
([`src/pair.rs`](src/pair.rs)). Three ways to pair it, each with the key
Settings › Machines shows:

- **The installer asks.** At the end of either script, on an unpaired
  machine with a terminal to ask on (`/dev/tty` under `curl | sh`; an
  interactive PowerShell), it asks for the key and runs `pair`. Enter, or a
  run without a terminal, skips it and prints the command.
- **`daedalus-agent pair --pin KEY [--controller HOST:PORT]`**, as root or
  an administrator. It writes config.toml through the same writer as
  `install` (every other line kept) and asks the running service to read it
  again (`link.reload`); the link starts over under the new keys at once.
  It re-pins a paired machine too. Without `--controller` the address stays
  config.toml's, else DNS's. `pair --check` exits 0 when paired.
- **The tray's "Pair with the box…"**, shown only while unpaired: a native
  text box (a GTK dialog on Linux, AppleScript's `display dialog` on macOS,
  PowerShell's `InputBox` on Windows) takes the key, or a whole pair or
  install line from the Machines page. The tray checks it (a key, and
  host:port if one is given — nothing else goes on), then runs the `pair`
  verb above **elevated**, behind the OS's own prompt: UAC on Windows
  (`ShellExecuteExW`, verb `runas`), the administrator password on macOS
  (`do shell script … with administrator privileges`, each argument quoted
  by AppleScript), polkit's `pkexec` on Linux — and where there is no
  pkexec, or polkit cannot ask, it shows the `sudo daedalus-agent pair …`
  line to type. Pairing asks what `install` asks because the controller a
  machine trusts commands its service (power, Claude, updates): a user who
  could pair a fresh machine to a controller of their own would hold root
  or SYSTEM on it. The local socket has no pairing method.

Settings › Machines also gives lines that pair as they install (`--pin`,
`--controller`), and the `pair` line for each system.

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
`src/jobs/` has what a job is and the pure command lines;
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

## Verbs

```
daedalus-agent install [--controller HOST:PORT] [--pin FINGERPRINT]
                                    register and start the service, the session and the tray (administrator / sudo);
                                    --controller and --pin name the controller and pin its key in config.toml;
                                    without --pin the machine runs unpaired. macOS: no options (the Mac logs in)
daedalus-agent pair --pin FINGERPRINT [--controller HOST:PORT]
                                    pair it: trust that controller key (administrator / sudo); the running
                                    service connects at once. pair --check exits 0 when paired. Not on macOS
daedalus-agent enroll-finish CODE   (macOS, Linux) a log-in's last step, as root; the menu bar runs it behind the password prompt
daedalus-agent uninstall            stop and remove them (administrator / sudo)
daedalus-agent run                  service entry point; what the SCM, launchd or systemd calls (and nix, for the controller)
daedalus-agent serve                the same work in the foreground, in a terminal
daedalus-agent session              the Claude session without a tray: the Linux user unit (refused where the tray runs it, and on the controller)
daedalus-agent status               print the running agent's status document (through the local socket)
daedalus-agent update [--apply]     check the release feed now; --apply installs
daedalus-agent claude restart       ask the session to restart `claude remote-control`
daedalus-agent claude-holder "…"    (Windows) a resumed session's pseudo-console; the tray starts it, never by hand
daedalus-agent root-helper --table FILE
                                    (the box) one connection to the root helper; its socket unit starts it, never by hand
daedalus-agent version
```

## On the machine

Windows:

```
C:\Program Files\daedalus-agent\daedalus-agent.exe        the service (.old / .new around an update, .bad after a rollback)
C:\Program Files\daedalus-agent\daedalus-agent-tray.exe   the tray, started at logon
C:\ProgramData\daedalus-agent\config.toml                 local knobs, never policy (src/config.rs); edit and restart
C:\ProgramData\daedalus-agent\state.json                  the last update check and install, an update on probation, a version rolled back from
\\.\pipe\daedalus-agent                                   the local socket: the tray, the session and the verbs
C:\ProgramData\daedalus-agent\identity.key                the machine's key, DPAPI-wrapped
C:\ProgramData\daedalus-agent\policy.json                 the last policy the controller sent, what a restart starts from
C:\ProgramData\daedalus-agent\logs\agent.log.*            the service's daily-rotated log (SYSTEM and Administrators only)
%LOCALAPPDATA%\daedalus-agent\logs\                       the tray's and the session's logs: claude-rc.log, claude-session-<uuid>.log
%LOCALAPPDATA%\daedalus-agent\jobs\<job>.json             each Claude job's pid and creation time, to re-attach by
%LOCALAPPDATA%\daedalus-agent\claude-recovery.json        the sessions to resume after a Remote Control restart
```

macOS:

```
/Library/Application Support/daedalus-agent/bin/daedalus-agent        the service (.old / .new around an update, .bad after a rollback)
/Library/Application Support/daedalus-agent/bin/daedalus-agent-tray   the menu bar app
/Library/Application Support/daedalus-agent/{config.toml,state.json,identity.key,policy.json,logs/}
/Library/Application Support/daedalus-agent/tunnel.toml              the WireGuard client config from the log-in (root's, 0600); absent: logged out
/Library/Application Support/daedalus-agent/run/agent.sock            the local socket: the menu bar app and the verbs
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
/opt/daedalus-agent/bin/daedalus-agent                the service (.old / .new around an update, .bad after a rollback); /usr/local/bin links to it
/opt/daedalus-agent/bin/daedalus-agent-tray           the tray, x86_64 desktops only
/var/lib/daedalus-agent/{config.toml,state.json,identity.key,policy.json,session.json,logs/}
/var/lib/daedalus-agent/run/agent.sock                the local socket: the session, the tray and the verbs
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
`controller_pin` when `--controller` and `--pin` name them (as `pair` does later); every key is
optional, and a top-level key the agent does not know is ignored. The
header of [`src/config.rs`](src/config.rs) is the reference.

```toml
port = 7787               # the controller's metrics page (/healthz, /nodes/metrics); a node listens on none
update_check_secs = 600   # how often the release feed is asked
auto_update = true        # the older spelling of `updates`
log_level = "info"        # "debug" for a bug report
search_domains = []       # more domains to ask for _daedalus-controller._tcp
# mode = "node"           # node | controller (see "Controller mode")
# telemetry = "full"      # full | minimal | off
# updates = "self"        # self | staged | external
# data_dir = "…"          # see above
# controller_address = "…" # the controller's link address, host:port; absent: DNS
# controller_pin = "…"     # its key's fingerprint; absent: unpaired (install --pin, pair --pin; a Mac's log-in)
# app_url = "…"            # the app a Mac last logged in to, offered at the next "Log in…"
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

Every ten minutes (`update_check_secs`), and when the tray or the box asks
(a nudge that wakes the updater at once), the agent lists the repository's
releases, keeps the `agent-v<semver>` ones that are neither drafts nor
prereleases and are newer than its own, and reads each one's `release.json`,
newest first, until one holds (`src/update/`). GitHub's listing says only
where to look; the manifest says what the release is — product, version,
tag, and per asset its target, role, name, SHA-256 and size — and must be
signed by a key in `RELEASE_PUBLIC_KEYS` over a context of its own, its
version its tag's, and carry this binary's own target's required assets (on
Linux the service alone; the tray is optional and follows only where it is
installed). So a re-published old binary, another target's binary under
this one's name or a moved tag is refused. Unless config.toml says only to
report it (`updates`, or `auto_update = false`), it streams each asset to
`.new` through a cap at its stated size, hashing on the way, keeps it only
when size and hash are the manifest's and flushes it to disk, records the
probation in `state.json` (and installs nothing when that cannot be
saved), renames the running binaries to `.old`, moves the new ones into
place, asks the new service binary its version — the manifest's, or
everything goes back and that version is refused — and exits with code 3. The service's recovery action (launchd's KeepAlive on
macOS, `Restart=always` on Linux) starts it on the new binary; the tray and
the session see the status document report a version other than their own and restart
(the Linux session unit by leaving, for systemd to start it again), and the
first start of the new service restarts them itself as well — the Windows
trays ended (`taskkill`) and the console user's started again, the Mac's
menu bar app kickstarted (`launchctl kickstart -k`), the Linux session unit
restarted in its user's manager — so they run the version the service does
whatever version they were. A Linux tray whose page stops answering after
its binary was replaced leaves for the new one too. Claude keeps running in
its jobs on every OS and is re-attached. A release whose signature fails is
reported in the status document and never installed.

**Probation, and going back.** A signed binary is not trusted until it has
run. The update records the new version on probation in `state.json`
(`probation`: the version, the one it replaced, its starts), and its
`.old` binaries stay. Each start of that version under the service manager
(`run`, never a `serve` in a terminal) counts itself as the first thing the
service does — before it even reads config.toml. It has proved itself once
its local socket has been served for two minutes and, when someone is logged on
who runs a tray or a session (a console session with a user on Windows, a
console user on a Mac, the session user's systemd manager running on
Linux), that tray or session has reported to it; with nobody logged on the
two minutes are enough. The log names the rule that proved it; then the
record is cleared and the `.old` files retired. A run that has not proved
itself within five minutes exits, which counts as a failed start. A
version that starts more than three times without proving itself — the
service manager starting it again after each crash or exit (systemd after
3 s, launchd after 5 s, the SCM after 3, 10 and 60 s) — is rolled back at
its next start: the `.old` binaries go back in place, the failed ones
become `.bad` (retired later), `state.json`'s `rolled_back` names the
version and `last_update_result` says why, and the service exits for the
service manager to start the version put back. That version is never
installed again; a newer release is. While a version is on probation
nothing newer is installed over it, and `update --apply` refuses while the
service runs (its state would be saved over). A binary that dies before
`main` is past what it can count — none signed for this target does.

On the controller, a metrics page whose port another process holds does
not stop the service: the rest runs on, the port is tried again every 15 s,
and the log names the port's holder (its uid). One service runs per data
directory (`agent.lock` there).

## Versions

The version an agent reports names the build exactly. A release is the
crate's version alone (`0.21.0`), built by CI from the tag, whose name the
`guard` job holds to `Cargo.toml`. Every other build carries the source it
was made from as semver build metadata: nix builds the controller from the
crate's own files alone (`Cargo.toml`, `Cargo.lock`, `build.rs`, `src/`),
a content-addressed store path, and passes the start of that path's hash as
`DAEDALUS_BUILD_ID`; `build.rs` reports `0.21.0+src.1a2b3c4d5e6f`. The id
moves when one of those files does and never otherwise, so an engine
commit that leaves the crate alone rebuilds nothing and restarts nothing.
Build metadata does not order versions, so the updater compares releases
alone. Bump `Cargo.toml` with every change under `agent/src` that is meant to ship: the
next release's number, which the box's build carries until it is tagged.

## Releasing

Bump `version` in `Cargo.toml`, commit, tag `agent-v<version>` on a commit
on `main`, push the tag. [`.github/workflows/agent.yml`](../.github/workflows/agent.yml) builds
the Windows binaries, the macOS universal binaries, the static Linux
service for x86_64 and aarch64 (musl, rustls; each on a runner of its own
architecture) and the Linux tray for x86_64 (glibc, GTK), every build
`--locked`; writes `release.json`, signs it once with `AGENT_SIGNING_KEY`
(held in the `release` environment, `agent-v*` tags only, the operator the
required reviewer), checks the signature against the compiled-in key, and
publishes the release. The tag and `Cargo.toml` must agree, and the tagged
commit must be on `main`, or nothing is published. For one release the
assets are also signed one by one, as agents up to 0.20 verify them.

The agent trusts every key in `RELEASE_PUBLIC_KEYS`: the current one, and
a spare made and kept offline (PLAN, owed to the operator). Losing every
listed private key strands every installed agent on its version; a leaked
current key is left by a release the spare signs that drops it.

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
(`src/jobs/`) — and the service, the power request, the tray,
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
