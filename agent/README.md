# daedalus-agent

The box's presence on a machine it does not run: a Windows service or a
macOS launchd daemon, with a tray / menu bar app beside it, that

- **holds the machine awake** for as long as the box wants it to — a Windows power
  request visible in `powercfg /requests` (an IOKit assertion on macOS, in
  `pmset -g assertions`), plus, on Windows, the power plan's sleep and
  hibernate timers set to never as a second line;
- **answers a status page** on the LAN, `http://<machine>:7787/status`, so
  the box can see the agent is there before any channel exists between
  them — machine facts and a summary of Claude Code; the full Claude
  report (sessions, paths, ids) is on `/claude`, which answers only on
  loopback or to the node token the box mints at approval and hands down
  every hello answer;
- **reports the machine** the way the box reports itself: what it is
  (make, model, chassis, firmware, board, the memory modules from SMBIOS
  or `system_profiler`), what it is running (kernel, build, install date),
  and how it is doing — processor and GPU usage, memory with its cache,
  compressor and commit charge, every volume, every physical drive with
  the OS's health verdict and, on Windows, its temperature, hours, wear and
  error counters, temperatures where an OS states them, network rates,
  battery (with its cycle count and the OS's condition on a Mac). Sampled
  every fifteen seconds; drives and the services that should be running
  and are not every ten minutes; the OS's pending and recently installed
  updates hourly; and with the slow facts the Chromium-based browsers
  installed (Chrome, Edge, Brave, Arc, Vivaldi, Opera, Chromium: version,
  channel, open or not, which is the default) and everything else
  installed — on Windows the Uninstall keys, the Store and the Steam and
  Epic games, each sorted as app, game, launcher, runtime or driver; on a
  Mac the Applications folders, each tagged App Store, Homebrew, Setapp or
  Apple's own. A GPU carries its driver's marketed version and build date
  where the vendor writes one (AMD's Adrenalin, NVIDIA's GeForce number);
  a Mac carries its board target (`hw.target`), the name Apple's software
  catalogue lists supported machines by. The status page carries the
  machine and nothing that identifies a person (no serials, no process
  list, no installed applications — a count only); the full document —
  the heaviest processes, the failing services, the updates, the serials,
  the applications — is on `/telemetry`, gated like `/claude`; and
  `/metrics` renders it as Prometheus gauges for the box to scrape;
- **updates itself** to the newest `agent-v*` release of this repository,
  verifying every asset against the ed25519 key compiled into it;
- **announces itself to the box** every minute: an ed25519 key made on first
  start (DPAPI-wrapped under ProgramData) signs a hello carrying the
  machine's name, OS edition and version, processor, memory, address and
  state; the box is found through the `_daedalus._tcp` SRV record under
  the DNS search domain DHCP handed out (or `control_plane_url` in the
  config), and appears on System › Machines as "wants to join" until an
  admin approves it. The answer carries the box's **policy** for an
  approved machine — hold it awake or not, run Claude remote control or
  not, set on Settings › Machines — and two one-shot instructions, "check
  for updates now" and "restart Claude remote control";
- **runs Claude Code's remote control** the way the box runs its own: the
  tray (the one process in the user's desktop session, where the Claude
  login lives) supervises `claude remote-control --verbose`, restarts it
  with backoff, writes its output to `logs\claude-rc.log`, and reports it
  to the service — state, versions, environment id, the sessions under it,
  the credential clock (dates and plan, never a token). The status page
  carries the report, the hello a summary, and the box's Claude page has a
  machine picker that shows it. Nobody logged on means no tray and no
  server, so a machine that reboots unattended wants automatic sign-in;
- **shows itself in the tray**: a second, windowless program in the desktop
  session (`daedalus-agent-tray.exe`, started at every logon) draws the
  daedalus mark beside the clock — ember when all is well, an amber dot
  when an update is pending, the hold failed or Claude is not running, grey
  when the service does not answer — with the state in its tooltip and
  menu, and the actions: open the status page, check for updates now,
  restart Claude remote control, open the logs, open Claude's log.

Nothing else yet: no other commands, no inbound port but the page's. What
the agent will do next arrives as a release the installed one applies on
its own, which is why the update path shipped first.

## Install

From an administrator PowerShell on the machine:

```powershell
Set-ExecutionPolicy -Scope Process Bypass -Force
irm https://daedalus.toscanini.me/install.ps1 | iex
```

The script downloads the release, places both binaries under
`C:\Program Files\daedalus-agent\`, registers the `daedalus-agent` service
(LocalSystem, automatic start, restart on failure), registers the tray under
the machine's Run key and starts it as the desktop user, opens TCP 7787 to
the local subnet, writes `C:\ProgramData\daedalus-agent\config.toml` if
there is none, and starts the service. Re-running it later replaces the binary and keeps the
config. `daedalus-agent uninstall` removes the service and the firewall
rule; the data directory stays.


On a Mac, from a terminal:

```sh
curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh
```

The script downloads the two universal binaries to
`/Library/Application Support/daedalus-agent/bin/`, registers the service as a
LaunchDaemon (root, at boot, kept alive) and the menu bar app as a
LaunchAgent for every user, starts both, and links `daedalus-agent` into
`/usr/local/bin`. Re-running it replaces the binaries and keeps the config;
`sudo daedalus-agent uninstall` removes both jobs. Claude Code is found in
`~/.local/bin`, Homebrew's bin or PATH, and its remote control runs in the
most recently used trusted project (or the directory the policy names).

Trust at install is HTTPS to GitHub. Every update after that is verified
by the agent against the release key it carries.

## Verbs

```
daedalus-agent install [--port N]   register and start the service (administrator / sudo)
daedalus-agent uninstall            stop and remove the service (administrator / sudo)
daedalus-agent run                  service entry point; what the SCM or launchd calls
daedalus-agent serve                the same work in the foreground, in a terminal
daedalus-agent status               print the running agent's status page
daedalus-agent update [--apply]     check the release feed now; --apply installs
daedalus-agent claude restart       ask the tray to restart `claude remote-control`
daedalus-agent version
```

## On the machine

```
C:\Program Files\daedalus-agent\daedalus-agent.exe        the service (.old / .new around an update)
C:\Program Files\daedalus-agent\daedalus-agent-tray.exe   the tray, started at logon
C:\ProgramData\daedalus-agent\config.toml            port, release repo, check interval, auto_update, log level, awake_hold, claude_remote_control, claude_workdir (empty = the most recent trusted project; Claude refuses the home directory)
C:\ProgramData\daedalus-agent\state.json             last update check and result
C:\ProgramData\daedalus-agent\logs\agent.log.*       daily-rotated log
C:\ProgramData\daedalus-agent\logs\claude-rc.log      what `claude remote-control` printed
```
On macOS:

```
/Library/Application Support/daedalus-agent/bin/daedalus-agent        the service (.old / .new around an update)
/Library/Application Support/daedalus-agent/bin/daedalus-agent-tray   the menu bar app
/Library/Application Support/daedalus-agent/{config.toml,state.json,identity.key,logs/}
/Library/LaunchDaemons/me.toscanini.daedalus-agent.plist              the service's job
/Library/LaunchAgents/me.toscanini.daedalus-agent-tray.plist          the menu bar app's job
~/Library/Logs/daedalus-agent/                                        the menu bar app's logs (claude-rc.log)
```


## How an update happens

Every ten minutes (config `update_check_secs`) the agent lists the
repository's releases, keeps the `agent-v<semver>` ones that are neither
drafts nor prereleases, and takes the highest above its own version. It
downloads that release's two executables and their `.sig`s, checks each raw
ed25519 signature against `RELEASE_PUBLIC_KEY_HEX` in `src/update.rs`,
renames the running binaries to `.old`, moves the new ones into place and
exits with code 3. The service's recovery action starts it again on the new
binary; the tray notices the page now reports a version other than its own
and relaunches itself; the next clean start deletes the `.old` files. A release
without a valid signature is reported on the status page and never
installed.

## Releasing

Bump `version` in `Cargo.toml`, commit, tag `agent-v<version>`, push the
tag. `.github/workflows/agent.yml` builds the Windows binary and the two
macOS universal binaries, signs every one with the `AGENT_SIGNING_KEY`
secret, checks the signatures against the compiled-in public key, and
publishes the release. The tag and `Cargo.toml` must agree or the build
refuses.

The private key has no recovery path but the operator's copies; losing it
strands every installed agent on its version. Rotation is a release signed
with the old key that carries the new public key.

**Apple's signature.** The macOS binaries are codesigned (Developer ID,
hardened runtime) and notarized on the runner when the repository's
`release` environment holds the same six secrets santree's release uses:
`APPLE_CERTIFICATE` (the Developer ID Application .p12, base64),
`APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` (the certificate's
common name), `APPLE_API_KEY` (the App Store Connect .p8), `APPLE_API_KEY_ID`
and `APPLE_API_ISSUER`. Without them the job warns and ships the binaries
unsigned by Apple — launchd runs them all the same, and the updater trusts
only our own signature — so the environment can be filled in later without a
code change. Bare executables notarize but cannot be stapled; a Mac that is
online fetches the ticket.

## Developing without Windows or a Mac

The crate cross-checks and lints against `x86_64-pc-windows-gnu` and
`aarch64-apple-darwin` from Linux (`rustup target add` both, plus
`gcc-mingw-w64-x86-64` for the Windows linker; the macOS check needs no
Apple toolchain because the agent uses the OS's TLS through native-tls
rather than a C crypto library). The tests are platform-neutral and run
anywhere. The service, the power request, the tray and `install` are
exercised on the machines themselves.
