# daedalus-agent

The box's presence on a machine it does not run: a Windows service or a
macOS launchd daemon, with a tray / menu bar app beside it. It

- **holds the machine awake** while the box's policy says so — a Windows
  power request (`powercfg /requests`) or a macOS IOKit assertion
  (`pmset -g assertions`), plus, on Windows, the power plan's sleep and
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
  `src/telemetry.rs`;
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
  tray, the one process in the user's desktop session where the Claude
  login lives, supervises `claude remote-control --verbose`, restarts it
  with backoff, logs its output to `claude-rc.log`, and reports its state,
  versions, sessions and credential dates (never a token) to the service
  (`src/claude/mod.rs`). Nobody logged on means no tray and no server, so a
  machine that reboots unattended wants automatic sign-in;
- **shows itself in the tray**: the daedalus mark — ember when all is well,
  an amber dot when an update is pending, the hold failed or Claude is not
  running, grey when the service does not answer — with the state in its
  tooltip and menu, and the actions: open the status page, check for
  updates, restart Claude remote control, open the logs, open Claude's log;
- **updates itself** to the newest `agent-v*` release of this repository,
  verifying every asset against the ed25519 key compiled into it.

## Install

From an administrator PowerShell on the machine:

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

On a Mac, from a terminal:

```sh
curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh
```

[`install.sh`](install.sh) downloads the two universal binaries, registers
the service as a LaunchDaemon (root, at boot, kept alive) and the menu bar
app as a LaunchAgent for every user, starts both, and links
`daedalus-agent` into `/usr/local/bin`. Re-running replaces the binaries
and keeps the config; `sudo daedalus-agent uninstall` removes both jobs.

The site serves both scripts from `main`, so neither command names a
version. Trust at install is HTTPS to GitHub; every update after that is
verified by the agent against the release key it carries.

## Verbs

```
daedalus-agent install [--port N]   register and start the service and the tray (administrator / sudo)
daedalus-agent uninstall            stop and remove them (administrator / sudo)
daedalus-agent run                  service entry point; what the SCM or launchd calls
daedalus-agent serve                the same work in the foreground, in a terminal
daedalus-agent status               print the running agent's status page
daedalus-agent update [--apply]     check the release feed now; --apply installs
daedalus-agent claude restart       ask the tray to restart `claude remote-control`
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

Claude Code is looked for in `~/.local/bin`, npm's bin, Homebrew's bin and
PATH. Its remote control runs in the directory the policy names, else the most recently used trusted project (Claude refuses the home
directory; `src/claude/workdir.rs`).

## How an update happens

Every ten minutes (`update_check_secs`), and when the tray or the box asks,
the agent lists the repository's releases, keeps the `agent-v<semver>` ones
that are neither drafts nor prereleases, and takes the highest above its own
version. It downloads that release's two executables and their `.sig`s,
checks each raw ed25519 signature against `RELEASE_PUBLIC_KEY_HEX` in
[`src/update.rs`](src/update.rs), renames the running binaries to `.old`,
moves the new ones into place and exits with code 3. The service's recovery
action (launchd's KeepAlive on macOS) starts it on the new binary; the tray
sees the page report a version other than its own and restarts; the next
clean start deletes the `.old` files. A release whose signature fails is
reported on the status page and never installed.

## Releasing

Bump `version` in `Cargo.toml`, commit, tag `agent-v<version>`, push the
tag. [`.github/workflows/agent.yml`](../.github/workflows/agent.yml) builds
the Windows binaries and the macOS universal binaries, signs every one with
the `AGENT_SIGNING_KEY` secret, checks the signatures against the
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

[`gate.sh`](gate.sh) runs fmt, clippy for Linux, Windows
(`x86_64-pc-windows-gnu`) and macOS (`aarch64-apple-darwin`), and the tests
in a throwaway rust container: `agent/gate.sh [fmt|check|test|all]`. The
macOS check needs no Apple toolchain because TLS comes from the OS through
native-tls, not a C crypto library. The tests are platform-neutral; the
service, the power request, the tray and `install` are exercised on the
machines themselves.
