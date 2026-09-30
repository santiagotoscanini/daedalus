# daedalus-session-host

The box's end of [santree](https://github.com/santree-ai/santree)'s remote
projects. santree talks to the daedalus agent on its own machine; the agent
opens a pinned TLS 1.3 connection to this host with its **node key** and pipes
santree's protocol v1 through it. Here the protocol runs: PTY sessions that
outlive the link, `exec.run` (argv, no shell), `fs.read` / `fs.write` /
`fs.stat`, a queue of agent hook events, and `workspaces.list`. Primitives
only; the logic stays in santree.

Standalone crate with its own `Cargo.lock` (no engine workspace). Nix builds
and runs it: `nix/stacks/daedalus/session-host.nix`, whose header says how the
unit is set up and why.

**Trust.** An admitted node is a login as the operator, who has NOPASSWD
sudo: root on the box. Admission is the allow-list below, nothing else.

## CLI

```
daedalus-session-host --version
daedalus-session-host serve --config FILE
daedalus-session-host hook [--socket PATH] <event args…>
```

- `--version` prints exactly `daedalus-session-host 0.1.0 protocol 1`.
- `serve` runs the host until SIGTERM/SIGINT; then it stops accepting,
  removes the hook socket, closes every PTY (santree-pty's bounded
  `close_all`), writes a last status file with `"state": "stopped"`, and
  exits 0.
- `hook` is what agents' hooks on the box run (below).

## Config

`serve --config` reads one JSON object (nix writes it); every path absolute,
unknown keys refused:

| key | what |
|---|---|
| `listen` | TLS listeners, `["0.0.0.0:7789"]` |
| `stateDir` | this host's directory: `host.key`, `status.json` (made 0700 when missing) |
| `allowList` | the allow-list file the controller writes |
| `hookSocket` | the local hook socket, `/run/daedalus-session-host/hook.sock` |
| `projectsRoot` | where the checkouts live; confinement's root, `hello.projectsRoot` |
| `workspaces` | the control plane's workspaces snapshot, `/run/daedalus-workspaces/workspaces.json` |
| `hookBin` | `hello.hookBin`: `/run/current-system/sw/bin/daedalus-session-host` |

`host.key` is a 32-byte ed25519 seed, made on the first start (O_EXCL, 0600).
One that is not this uid's, not a regular file, readable by others or not 32
bytes stops the start; it is never replaced.

## The allow-list

Written by the controller — every approved node whose policy turns santree
on — atomically (temp file + rename) into its own data directory:

```json
{
  "schemaVersion": 1,
  "nodes": [
    { "id": "21fe31dfa154a261", "publicKey": "d75a9801…511a" }
  ]
}
```

- `publicKey`: the node's ed25519 public key, 64 hex characters.
- `id`: its node id, the first 16 hex characters of the key's SHA-256 (the
  agent's `node_id_of`); it must match the key. An id listed twice, a bad key
  or a mismatched id makes the file malformed. Unknown keys are ignored.

How it is read: its `(inode, mtime_ns, len)` is looked at every second and a
change re-read (the rename always changes the inode).

- **missing** → nobody is admitted (fail closed);
- **refused** — a symlink or not a regular file, not this uid's,
  group/other-writable, or over 1 MiB → nobody is admitted, logged;
- **malformed** → the last good set stays, logged (the controller writes whole
  files, so this is a bug, not a revocation).

The TLS handshake admits a key only while the current set holds it. A node
that leaves the set loses every connection and every PTY it opened within
about a second (each connection watches the set, re-checking right after it
subscribes, and PTYs are tagged with the node that opened them; an open racing
the change is refused).

## The link

- **TLS**: santree-remote-tls's `server_config` (santree's crate: santree's
  own client and this server build from one profile): TLS 1.3 only,
  ed25519 only, ring's provider, no resumption, tickets or 0-RTT, a client
  certificate mandatory. A key the set does not hold gets `access_denied`,
  which a TLS 1.3 client reads on its **first read**, not at connect. The
  daedalus agent's own client (its pure-Rust provider) meets it on X25519 +
  ChaCha20-Poly1305, proven by `interop/`.
- **Before admission** a connection holds a pre-auth slot — 32 in all, 3 per
  source address (an IPv6 /64 is one), as the controller's link counts them —
  and has 5 s to finish the handshake. A wg-easy tunnel peer and a container
  dialling the host both arrive from `127.0.0.1` (the DNAT and pasta reach the
  host over loopback): they share loopback's slots, and the log shows them as
  that address.
- **Accepted sockets**: TCP keepalive (15 s idle, 5 s × 3) and
  `TCP_USER_TIMEOUT` 30 s, so a vanished peer is noticed in about half a
  minute and its sessions parked.

## Protocol

Protocol v1 as santree's
[`docs/remote.md`](https://github.com/santree-ai/santree/blob/c9766c4539973e7959287d9fc65dff01c585c575/docs/remote.md)
specifies it at rev `c9766c45`, with the behaviour the doc leaves open taken
from santree's reference daemon (`crates/remote/src/fake.rs`) — `src/daemon.rs`
is a port of it by way of the parked 2026-09-27 daemon. Every wire type comes
from `santree-remote-proto` at that rev; PTYs are `santree-pty`. The tests
check exact wire order with a raw client and conformance with santree's own
`RemoteClient`.

`hello` answers `version` (this crate's), `hostname`, `user`/`home` (`$USER`
/ `$HOME`, else the passwd entry), `bootId` (16 hex from `/dev/urandom`, new
per start), `projectsRoot`, `hookBin`, and `features: ["workspaces.list"]`.

### Deviations from `docs/remote.md` / `fake.rs`

1. **Transport and identity**: TLS with the node key (above), not ssh stdio.
2. **`hooks.push` is served on the local hook socket only.** On the link,
   every method but `hello` answers `bad_request "send hello first"` until a
   hello succeeds, and `hooks.push` is `bad_request` even after.
3. **Confinement** — a guardrail against client bugs, not a boundary
   (`exec.run` runs any argv): the `cwd` of `pty.open` and `exec.run` is
   required (`bad_request`), must exist (`not_found`) and resolve under
   `projectsRoot` (`outside`); the process gets the resolved path. The parent
   of an `fs.write` must resolve under it too (`outside`), checked on its
   nearest existing ancestor before anything is made and again after. Reads
   and stats are not confined (`fs.read` keeps its `within`).
4. **Caps**, answered with the error code `busy` (not in the doc's list;
   santree reads it as `ErrorCode::Other("busy")`): 64 PTYs on the host (live
   or exited), 32 requests running per connection. A node's 5th connection is
   closed right after its handshake. An exited session nobody is attached to
   is closed after an hour.
5. **Output is bounded**: 1024 lines queued per connection. A peer that stops
   reading fills it; the link is dropped and its sessions parked — the ring
   replays what it missed on the next attach.
6. **`exec.run` runs in a process group of its own**, killed whole on a
   timeout, on output that never closes, and when the request is dropped (its
   connection ended). Output is capped at 8 MiB a stream, as the fake: two
   capped streams in base64 still fit one 32 MiB line.
7. **`workspaces.list`** serves the control plane's snapshot (below).
8. **Shutdown closes sessions**; under systemd the cgroup kill would take them
   anyway.
9. **Framing**: `read_line` is copied from santree's `framing.rs` (it is
   `pub(crate)` there) without its idle bound: the client times a silent link
   out, and keepalive catches a vanished peer.
10. **Parking** after a dropped connection runs on a blocking task, keeping the
    manager's locks off the async workers; the behaviour is the fake's.

Everything else matches the fake: newline JSON with a 32 MiB line cap (empty
lines skipped, an undecodable line logged and unanswered), concurrent
requests, a ping every 15 s (the first after one interval), repeatable
`hello` (another protocol gets `version` with `"protocol": 1` and the
connection stays open), the attach gate and replay, one receiver per session,
detach-not-close on a drop, `pty.exit` after attaching to an exited session,
exited sessions listed `alive: false` until closed, `pty.adopt` dedupe,
`GIT_OPTIONAL_LOCKS=0` last, exec timeouts (60 s default, 1 ms–10 min),
`fs.*` semantics, the 10k hook queue (newest subscriber only; response, then
the dropped report, then the backlog; `ack` keeps `seq > upTo`), and a
request's `env` overlaying the host's for that call only.

### `workspaces.list`

The snapshot the workspace sync publishes
(`{generatedAt, data: {root, workspaces: [{name, remote, branch, head,
headAt, dirty, ahead, behind, sync}]}}`) as `{root, generatedAt,
workspaces}`, each workspace with `path` = `<projectsRoot>/<name>`. A name
that is not one plain component is skipped. No snapshot yet: an empty list
with `generatedAt: null`. A snapshot of another root serves none; an
unreadable or malformed one is an `io` error.

## Hooks

Agents on the box run `<hookBin> hook <event args…>` as their hook command.
It:

- takes `--socket P` / `--socket=P` only as its first argument (default
  `/run/daedalus-session-host/hook.sock`); the event is every other argument
  joined with single spaces, unparsed;
- reads stdin for at most 120 ms (a TTY counts as empty; what arrived by then
  is pushed, noted in the log);
- sends one `hooks.push` with `env` = every `SANTREE_*` variable plus
  `CLAUDE_PROJECT_DIR` (non-UTF-8 values skipped) and waits for its answer,
  all within 200 ms;
- always exits 0 and never writes to stdout or stderr, even on a panic; a
  failure appends one line — a time and a reason, never stdin or env — to
  `$HOME/.local/state/daedalus-session-host/hook-errors.log` (dir 0700, file
  0600).

The hook socket is 0600 in the unit's 0700 RuntimeDirectory, and serves only
a peer of this uid (SO_PEERCRED): `hooks.push` and nothing else, one request
line and one response line each, no `hello`. **This framing is frozen with
protocol v1**: `hookBin` is always the newest build while the running host may
be older.

## Status file

`<stateDir>/status.json`, for the controller. Written atomically (0600) at
start, after every change at most once a second, at least every 10 s, and a
last time on shutdown:

```json
{
  "schemaVersion": 1,
  "generatedAt": "2026-09-29T10:00:00Z",
  "state": "running",
  "version": "0.1.0",
  "protocol": 1,
  "bootId": "673f40a95858c4ef",
  "pid": 1234,
  "startedAt": "2026-09-29T09:00:00Z",
  "exe": "/nix/store/…-daedalus-session-host-0.1.0/bin/daedalus-session-host",
  "hostKey": "<64 hex>",
  "listen": ["0.0.0.0:7789"],
  "connections": [
    { "node": "21fe31dfa154a261", "peer": "192.0.2.10:51544",
      "connectedAt": "2026-09-29T09:30:00Z", "client": "santree/0.1.17" }
  ],
  "sessions": 3
}
```

- `state`: `running` | `stopped`. A file older than ~10 s is a host that is
  not running (killed, or never started).
- `exe`: `/proc/self/exe` at start — the build this process runs. The
  controller compares it with the installed one: different means "update
  installed, restart to apply" (the unit is never restarted by a switch).
- `hostKey`: the key nodes pin, raw, 64 hex — also in the `stopped` file.
- `connections`: one per admitted connection; `client` is `hello.client`,
  null until a hello succeeds.
- `sessions`: PTYs whose process is still running — what a restart ends.
  `stopped` lists no connections and 0 sessions.

## Logging

stderr, one line per event, no timestamps (journald adds them), with a `<N>`
syslog prefix when stderr is the journal. `SESSION_HOST_LOG` =
`off|error|warn|info|debug|trace` (default `info`).

An audit trail, never data: connections (node id, peer address, open, close,
why), refused handshakes, the allow-list's changes, revocation closing a PTY,
each `pty.open` (command, cwd), `pty.close`, `pty.adopt`, `exec.run`
(argv[0], cwd), `fs.write` (path), and every failed request (method, id, code,
message). Never PTY data, `pty.write` input, exec stdin or output, file
contents, hook payloads or env values.

## Build and test

`gate.sh` runs everything in a throwaway `rust:1` container: fmt, clippy
`-D warnings`, the tests, a `--locked` build on rustc 1.95 (the box's nixpkgs),
and `interop/`. CI (`.github/workflows/session-host.yml`) runs the same.

- `tests/host.rs` drives the built binary over TLS on `127.0.0.1:0` with
  throwaway keys. The tests need `sh`, `seq`, `sleep` and `git` on `PATH` and a
  writable `/tmp` (socket paths must fit 108 bytes); one waits the full 15 s
  for the first ping.
- `interop/` is a crate of its own so the agent's dependency tree stays out of
  this crate's lock and nix build: it runs a host in process and connects with
  `daedalus_agent::link::tls::Client` — an allowed node key is answered, an
  unlisted one reads `access_denied`.

The nix build takes santree's crates by the git rev in `Cargo.lock`
(`allowBuiltinFetchGit`): the rev is the pin, so moving santree is a
`Cargo.toml` rev change (all four santree entries) and `cargo update -p
santree-pty` in both crates (one git source: every santree crate moves
with it), nothing else.
