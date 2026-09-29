//! The Linux side of `install`, `uninstall` and `run` — Linux's `os::svc`:
//! a root system service, a user unit for the session, and an XDG
//! autostart entry for the tray.
//!
//!   /etc/systemd/system/daedalus-agent.service
//!       the service, as root, at boot, restarted whenever it exits —
//!       `daedalus-agent run`. Root for the reasons LocalSystem and a
//!       LaunchDaemon are: the updater writes over the binary (and exits 3
//!       for systemd to start the new one), SMART and the SMBIOS table are
//!       root's to read, and the logind inhibitor should outlive any login.
//!   /etc/systemd/user/daedalus-agent-session.service
//!       the session — `daedalus-agent session` — in the user's own systemd
//!       manager, enabled for the user who ran `sudo` (`$SUDO_USER`), with
//!       lingering on so it runs from boot with nobody logged in. It runs
//!       Claude remote control as a transient unit of its own
//!       (`daedalus-claude-rc.service`, jobs/), so restarting or
//!       updating the agent never ends a Claude session.
//!   /etc/xdg/autostart/daedalus-agent-tray.desktop
//!       the tray, at every graphical login, where the release carried one
//!       (x86_64); a UI over the session, owning nothing.
//!
//! Who the session belongs to, and whether `install` turned lingering on,
//! is kept in the data directory's `session.json`, so `uninstall` undoes
//! exactly that — and the service's local socket serves that user
//! (local.rs). Nothing listens on the network, so no firewall is touched.
//!
//! `run` is `agent_main` with SIGTERM as the stop: systemd sends it on
//! `stop`, `restart` and at shutdown (the relay is unix.rs's
//! `on_interrupt`).

use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use crate::config::{self, Config};
use crate::exec;
use crate::paths;
use crate::TRAY_EXE;

/// Where `install` keeps the binaries it registers: root's, 0755, made by
/// install (or checked to be as safe), never a directory someone else can
/// write — the service runs what is there as root.
pub const INSTALL_DIR: &str = "/opt/daedalus-agent/bin";
/// The oldest systemd this supports: `StandardOutput=append:` (the Claude
/// unit's log) arrived in 240.
pub const MIN_SYSTEMD: u32 = 240;
pub const SERVICE_UNIT: &str = "daedalus-agent.service";
pub const SESSION_UNIT: &str = "daedalus-agent-session.service";
const SERVICE_PATH: &str = "/etc/systemd/system/daedalus-agent.service";
const SESSION_PATH: &str = "/etc/systemd/user/daedalus-agent-session.service";
const AUTOSTART_PATH: &str = "/etc/xdg/autostart/daedalus-agent-tray.desktop";
const DOCS: &str = "https://github.com/santiagotoscanini/daedalus/tree/main/agent";

/// systemd restarts the session unit and XDG autostart starts the tray;
/// the service watches neither.
pub const WATCHES_TRAY: bool = false;

/// The system unit. `Restart=always` is load-bearing: an update exits 3
/// and systemd starts the new binary. The hardening leaves the service
/// what its jobs need — its data directory and its own binary directory
/// writable (both outside what `ProtectSystem=full` makes read-only), the
/// block devices for SMART, logind on the bus, every process in /proc.
pub fn service_unit(exe: &Path) -> String {
    format!(
        "[Unit]\n\
         Description=Daedalus Agent: keeps this machine awake for the box, reports on it, updates itself\n\
         Documentation={DOCS}\n\
         Wants=network-online.target\n\
         After=network-online.target\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exe} run\n\
         Restart=always\n\
         RestartSec=3\n\
         TimeoutStopSec=20\n\
         UMask=0022\n\
         NoNewPrivileges=yes\n\
         ProtectSystem=full\n\
         ProtectHome=read-only\n\
         PrivateTmp=yes\n\
         ProtectKernelTunables=yes\n\
         ProtectKernelModules=yes\n\
         ProtectControlGroups=yes\n\
         RestrictSUIDSGID=yes\n\
         RestrictRealtime=yes\n\
         LockPersonality=yes\n\
         \n\
         [Install]\n\
         WantedBy=multi-user.target\n",
        exe = systemd_quote(&exe.display().to_string())
    )
}

/// The user unit. The Claude server is a unit of its own, so stopping or
/// restarting this one ends no Claude session.
pub fn session_unit(exe: &Path) -> String {
    format!(
        "[Unit]\n\
         Description=Daedalus Agent session: Claude Code remote control for this user\n\
         Documentation={DOCS}\n\
         \n\
         [Service]\n\
         Type=simple\n\
         ExecStart={exe} session\n\
         Restart=always\n\
         RestartSec=5\n\
         \n\
         [Install]\n\
         WantedBy=default.target\n",
        exe = systemd_quote(&exe.display().to_string())
    )
}

/// The tray's XDG autostart entry: every graphical login starts it.
pub fn autostart_entry(tray: &Path) -> String {
    format!(
        "[Desktop Entry]\n\
         Type=Application\n\
         Name=Daedalus Agent\n\
         Comment=This machine as the box sees it: the awake hold, updates, Claude remote control\n\
         Exec={tray}\n\
         Terminal=false\n\
         NoDisplay=true\n\
         X-GNOME-Autostart-enabled=true\n",
        tray = desktop_quote(&tray.display().to_string())
    )
}

/// A path as one word of a systemd command line (systemd.service(5),
/// "Command lines"): double-quoted, `\` and `"` escaped, and `%` (a
/// specifier) and `$` (a variable) doubled.
pub fn systemd_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '%' => out.push_str("%%"),
            '$' => out.push_str("$$"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// A path as one argument of a desktop entry's `Exec=` (the Desktop Entry
/// Specification, "The Exec key"): double-quoted, with `"`, `` ` ``, `$`
/// and `\` backslash-escaped inside the quotes — and that backslash
/// doubled again, since the value is itself an escaped string — and `%`
/// (a field code) doubled.
pub fn desktop_quote(s: &str) -> String {
    let mut out = String::from("\"");
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\\\\\"),
            '"' | '`' | '$' => {
                out.push_str("\\\\");
                out.push(c);
            }
            '%' => out.push_str("%%"),
            c => out.push(c),
        }
    }
    out.push('"');
    out
}

/// `systemctl --version`'s first line, "systemd 252 (252.22-1~deb12u1)":
/// the version number.
pub fn systemd_version(text: &str) -> Option<u32> {
    text.lines()
        .next()?
        .strip_prefix("systemd ")?
        .split_whitespace()
        .next()?
        .parse()
        .ok()
}

/// `daedalus-agent run` under systemd: the agent until SIGTERM or SIGINT.
pub fn run_service() -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    let relay = Arc::clone(&stop);
    super::on_interrupt(move || relay.store(true, Ordering::Relaxed));
    crate::agent_main(stop, false)
}

/// The session, the tray and the watchdog are systemd's and autostart's;
/// never called here (`WATCHES_TRAY` is false).
pub fn launch_tray_or_session() -> Result<()> {
    bail!("the session is the systemd user unit {SESSION_UNIT}; systemd restarts it")
}

fn is_root() -> bool {
    // SAFETY: no arguments.
    unsafe { libc::geteuid() == 0 }
}

fn require_root_and_systemd(verb: &str) -> Result<()> {
    if !is_root() {
        bail!("{verb} needs root: sudo daedalus-agent {verb}");
    }
    if !Path::new("/run/systemd/system").is_dir() {
        bail!("{verb} needs systemd as the init system; this machine does not run it");
    }
    let version = systemctl(&["--version"])
        .ok()
        .and_then(|t| systemd_version(&t));
    match version {
        Some(v) if v >= MIN_SYSTEMD => Ok(()),
        Some(v) => bail!(
            "{verb} needs systemd {MIN_SYSTEMD} or newer (the Claude unit's log uses \
             StandardOutput=append:); this machine runs systemd {v}"
        ),
        None => bail!("{verb} could not read the systemd version (systemctl --version)"),
    }
}

/// A tool's path, or why the step cannot run.
fn tool(name: &str) -> Result<PathBuf> {
    exec::locate(name).with_context(|| format!("no `{name}` on this machine"))
}

/// Run a command to completion, one minute at most; its stderr on failure.
fn run(mut cmd: Command) -> Result<String> {
    let what = format!("{cmd:?}");
    cmd.env("SYSTEMD_PAGER", "");
    exec::stdout_or(cmd, Duration::from_secs(60), exec::Text::Lossy)
        .map_err(|e| anyhow::anyhow!("{what}: {e}"))
}

fn systemctl(args: &[&str]) -> Result<String> {
    let mut cmd = Command::new(tool("systemctl")?);
    cmd.args(args);
    run(cmd)
}

/// Who the session unit was enabled for.
#[derive(Serialize, Deserialize, Debug, PartialEq, Eq)]
struct SessionUser {
    user: String,
    uid: u32,
    /// Lingering was off before `install` turned it on, so `uninstall`
    /// turns it off again.
    enabled_linger: bool,
}

fn session_record() -> PathBuf {
    paths::data_dir().join("session.json")
}

/// The user the session unit runs for, and whether their systemd manager
/// is up (lingering starts it at boot): then a session should be reporting
/// (update/, probation). None without an install's record.
fn session_user() -> Option<SessionUser> {
    let text = std::fs::read_to_string(session_record()).ok()?;
    serde_json::from_str(&text).ok()
}

/// Someone the machine runs Claude for is there to report: the session
/// user's manager runs, so its session unit should.
pub fn interactive_user() -> bool {
    session_user().is_some_and(|u| manager_socket(u.uid).exists())
}

/// After an update: the session unit restarted on the new binary, in its
/// user's manager (Claude runs on in its own units). The tray, a UI only,
/// follows by itself when it sees a newer service. A development run
/// (`DAEDALUS_AGENT_DATA_DIR`, the service as the user itself) restarts its
/// own `daedalus-agent-session-<hash>.service`, never the installed one.
pub fn restart_desktop_side() {
    let Some(u) = session_user().filter(|u| manager_socket(u.uid).exists()) else {
        return;
    };
    let unit = session_unit_name();
    let done = if crate::os::own_uid() == Some(u.uid) {
        systemctl(&["--user", "restart", &unit])
    } else {
        user_systemctl(&u.user, u.uid, &["restart", &unit])
    };
    match done {
        Ok(_) => tracing::info!(
            user = u.user,
            unit,
            "session unit restarted on the new version"
        ),
        Err(e) => tracing::warn!(
            user = u.user,
            unit,
            error = format!("{e:#}"),
            "session unit not restarted"
        ),
    }
}

/// The session unit's name: `SESSION_UNIT`, or under
/// `DAEDALUS_AGENT_DATA_DIR` one of its own, as the Claude unit gets.
fn session_unit_name() -> String {
    let claude = paths::claude_unit_name();
    match claude.strip_prefix("daedalus-claude-rc-") {
        Some(hash) => format!("daedalus-agent-session-{hash}.service"),
        None => SESSION_UNIT.to_string(),
    }
}

/// The uid `install` enabled the session for, from `session.json`; None
/// before an install recorded one (and under a development run, whose
/// service is the user itself).
pub fn session_uid() -> Option<u32> {
    let text = std::fs::read_to_string(session_record()).ok()?;
    serde_json::from_str::<SessionUser>(&text)
        .ok()
        .map(|r| r.uid)
}

/// The user who ran `sudo`, when it is not root.
fn sudo_user() -> Option<String> {
    std::env::var("SUDO_USER")
        .ok()
        .filter(|u| !u.is_empty() && u != "root")
}

fn uid_of(user: &str) -> Result<u32> {
    let mut cmd = Command::new(tool("id")?);
    cmd.args(["-u", user]);
    run(cmd)?
        .trim()
        .parse()
        .with_context(|| format!("no uid for {user}"))
}

/// The user manager's own socket: what `systemctl --user` and
/// `systemd-run --user` talk to, with or without a D-Bus session bus
/// (dbus-user-session is not on every minimal server).
fn manager_socket(uid: u32) -> PathBuf {
    PathBuf::from(format!("/run/user/{uid}/systemd/private"))
}

/// `systemctl --user …` in `user`'s own manager, through runuser with the
/// manager's runtime directory; systemctl finds the manager's socket there.
fn user_systemctl(user: &str, uid: u32, args: &[&str]) -> Result<String> {
    let mut cmd = Command::new(tool("runuser")?);
    cmd.args(["-u", user, "--"])
        .arg(tool("env")?)
        .arg(format!("XDG_RUNTIME_DIR=/run/user/{uid}"))
        .arg(tool("systemctl")?)
        .arg("--user")
        .args(args);
    run(cmd)
}

/// Lingering on for `user`, so their manager — and the session in it —
/// starts at boot. What this changed is written to session.json at once,
/// so `uninstall` can undo it even when a later step of `install` fails.
/// Then wait for the manager.
fn linger(user: &str, uid: u32) -> Result<bool> {
    let was_on = Path::new("/var/lib/systemd/linger").join(user).exists();
    if !was_on {
        let mut cmd = Command::new(tool("loginctl")?);
        cmd.args(["enable-linger", user]);
        run(cmd)?;
    }
    write_record(&SessionUser {
        user: user.to_string(),
        uid,
        enabled_linger: !was_on,
    })?;
    let socket = manager_socket(uid);
    let until = Instant::now() + Duration::from_secs(20);
    while !socket.exists() {
        if Instant::now() > until {
            bail!(
                "{user}'s systemd manager did not come up ({} is missing)",
                socket.display()
            );
        }
        std::thread::sleep(Duration::from_millis(250));
    }
    Ok(!was_on)
}

fn write_record(record: &SessionUser) -> Result<()> {
    std::fs::create_dir_all(paths::data_dir()).context("creating the data directory")?;
    std::fs::write(session_record(), serde_json::to_string_pretty(record)?)
        .context("writing session.json")
}

/// A unit or autostart file, mode 0644 whatever the umask: the user's
/// systemd manager and desktop session read them.
fn write_public(path: &str, text: &str) -> Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::write(path, text)?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o644))?;
    Ok(())
}

/// Whether a directory the service's binary lives in is safe to run from
/// as root and reachable by the user's session: owned by root, not
/// writable by group or others, enterable by others. Why not, otherwise.
fn dir_is_safe(uid: u32, mode: u32) -> std::result::Result<(), &'static str> {
    if uid != 0 {
        return Err("is not owned by root");
    }
    if mode & 0o022 != 0 {
        return Err("is writable by group or others");
    }
    if mode & 0o001 == 0 {
        return Err("cannot be entered by other users (the session runs as one)");
    }
    Ok(())
}

/// `/opt`, `/opt/daedalus-agent` and `INSTALL_DIR`: made 0755 by root when
/// absent; when present, only checked — `install` never changes the mode or
/// owner of a directory it did not make.
fn ensure_install_dir() -> Result<()> {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    let dir = Path::new(INSTALL_DIR);
    let mut chain: Vec<&Path> = dir.ancestors().filter(|p| p != &Path::new("/")).collect();
    chain.reverse();
    for d in chain {
        match std::fs::metadata(d) {
            Ok(m) => {
                if let Err(why) = dir_is_safe(m.uid(), m.mode()) {
                    bail!(
                        "{} {why}; install runs the service from it as root and will not change a directory it did not make",
                        d.display()
                    );
                }
            }
            Err(_) => {
                std::fs::create_dir(d).with_context(|| format!("creating {}", d.display()))?;
                std::fs::set_permissions(d, std::fs::Permissions::from_mode(0o755))?;
            }
        }
    }
    Ok(())
}

/// This binary — and the tray beside it, when there is one — in
/// `INSTALL_DIR`, copied there when it runs from anywhere else (moved into
/// place through a `.new`, so a running copy is never written over).
/// Returns the installed binary's path.
fn place_binaries(exe: &Path) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let dir = Path::new(INSTALL_DIR);
    let target = dir.join(crate::SERVICE_NAME);
    let same = std::fs::canonicalize(exe).ok() == std::fs::canonicalize(&target).ok();
    if same {
        return Ok(target);
    }
    let src_dir = exe.parent().context("the binary has no directory")?;
    for (src, name) in [
        (exe.to_path_buf(), crate::SERVICE_NAME),
        (src_dir.join(TRAY_EXE), TRAY_EXE),
    ] {
        if !src.is_file() {
            continue;
        }
        let dest = dir.join(name);
        let new = dir.join(format!("{name}.new"));
        std::fs::copy(&src, &new).with_context(|| format!("copying {}", src.display()))?;
        std::fs::set_permissions(&new, std::fs::Permissions::from_mode(0o755))?;
        std::fs::rename(&new, &dest).with_context(|| format!("placing {}", dest.display()))?;
        println!("{} copied to {}", src.display(), dest.display());
    }
    Ok(target)
}

/// What the session and the tray, running as the user, must reach: the
/// data directory to traverse and config.toml to read (the port). `sudo`
/// can carry a 077 umask, under which root would have made both root's
/// alone; the identity key stays 0600 (`os::write_private`). Both are the
/// agent's own directory and file.
fn readable_by_the_session() {
    use std::os::unix::fs::PermissionsExt;
    let entries = [
        (paths::config_dir(), 0o755),
        (paths::data_dir(), 0o755),
        (paths::config_path(), 0o644),
    ];
    for (p, mode) in entries {
        // Only what root owns: a `data_dir` pointed at someone's own
        // directory is theirs to set.
        let root_owned = std::os::unix::fs::MetadataExt::uid(&match std::fs::metadata(&p) {
            Ok(m) => m,
            Err(_) => continue,
        }) == 0;
        if root_owned {
            let _ = std::fs::set_permissions(&p, std::fs::Permissions::from_mode(mode));
        }
    }
}

/// `daedalus-agent install`: the binaries in `INSTALL_DIR`, the units, the
/// config, a start of both. Idempotent: a second run rewrites the units
/// (install.sh already replaced the binaries), leaves config.toml alone, and
/// restarts the service and the session onto the new binary.
pub fn install(cfg: &Config) -> Result<()> {
    require_root_and_systemd("install")?;
    ensure_install_dir()?;
    let exe = place_binaries(&std::env::current_exe().context("locating this binary")?)?;
    let bin = Path::new(INSTALL_DIR);
    std::fs::create_dir_all(paths::log_dir()).context("creating the log directory")?;
    let path = config::write_for_install(cfg)?;
    readable_by_the_session();
    println!("config at {}", path.display());

    write_public(SERVICE_PATH, &service_unit(&exe)).context("writing the service's unit")?;
    systemctl(&["daemon-reload"])?;
    systemctl(&["enable", SERVICE_UNIT])?;
    systemctl(&["restart", SERVICE_UNIT])?;
    println!("service {SERVICE_UNIT} registered and started");

    // The session, for the user whose Claude it runs.
    std::fs::create_dir_all("/etc/systemd/user").context("creating /etc/systemd/user")?;
    write_public(SESSION_PATH, &session_unit(&exe)).context("writing the session's unit")?;
    match sudo_user() {
        Some(user) => {
            let uid = uid_of(&user)?;
            let enabled_linger = linger(&user, uid)?;
            user_systemctl(&user, uid, &["daemon-reload"])?;
            user_systemctl(&user, uid, &["enable", SESSION_UNIT])?;
            user_systemctl(&user, uid, &["restart", SESSION_UNIT])?;
            println!(
                "session {SESSION_UNIT} enabled and started for {user}{}",
                if enabled_linger {
                    " (lingering turned on: it runs from boot, with nobody logged in)"
                } else {
                    " (lingering was already on)"
                }
            );
        }
        None => println!(
            "no session: run install with sudo from the account whose Claude Code should run here"
        ),
    }

    // The tray, where the release carried one.
    let tray = bin.join(TRAY_EXE);
    if tray.exists() {
        std::fs::create_dir_all("/etc/xdg/autostart").context("creating /etc/xdg/autostart")?;
        write_public(AUTOSTART_PATH, &autostart_entry(&tray))
            .context("writing the tray's autostart entry")?;
        println!("tray registered for every graphical login ({AUTOSTART_PATH})");
    } else {
        let _ = std::fs::remove_file(AUTOSTART_PATH);
        println!("no {TRAY_EXE} beside the service; this machine runs without a tray");
    }

    Ok(())
}

/// `daedalus-agent uninstall`: stop and remove the service, the session and
/// the tray's entry, stop the Claude server, and turn lingering off if
/// `install` turned it on. The binaries, config and identity stay.
pub fn uninstall() -> Result<()> {
    require_root_and_systemd("uninstall")?;
    let record: Option<SessionUser> = std::fs::read_to_string(session_record())
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok());
    let who = match &record {
        Some(r) => Some((r.user.clone(), r.uid)),
        None => sudo_user().and_then(|u| uid_of(&u).ok().map(|uid| (u, uid))),
    };
    if let Some((user, uid)) = &who {
        // A manager that is not running runs no session and no Claude unit;
        // one that is, whether or not a D-Bus session bus exists, answers
        // on its own socket.
        if manager_socket(*uid).exists() {
            let claude = format!("{}.service", paths::claude_unit_name());
            let _ = user_systemctl(user, *uid, &["disable", "--now", SESSION_UNIT]);
            let _ = user_systemctl(user, *uid, &["stop", &claude]);
            let _ = user_systemctl(user, *uid, &["reset-failed", &claude]);
            println!("session and Claude remote control stopped for {user}");
        }
        if record.as_ref().is_some_and(|r| r.enabled_linger) {
            let mut cmd = Command::new(tool("loginctl")?);
            cmd.args(["disable-linger", user]);
            let _ = run(cmd);
            println!("lingering turned off for {user}, as it was before install");
        }
    }
    let _ = systemctl(&["disable", "--now", SERVICE_UNIT]);
    for p in [SERVICE_PATH, SESSION_PATH, AUTOSTART_PATH] {
        if Path::new(p).exists() {
            std::fs::remove_file(p).with_context(|| format!("removing {p}"))?;
        }
    }
    let _ = std::fs::remove_file(session_record());
    systemctl(&["daemon-reload"])?;
    println!("service, session and tray entry removed; the data directory stays");
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    const EXE: &str = "/opt/daedalus-agent/bin/daedalus-agent";

    #[test]
    fn the_service_unit_is_this_text() {
        assert_eq!(
            service_unit(Path::new(EXE)),
            r#"[Unit]
Description=Daedalus Agent: keeps this machine awake for the box, reports on it, updates itself
Documentation=https://github.com/santiagotoscanini/daedalus/tree/main/agent
Wants=network-online.target
After=network-online.target

[Service]
Type=simple
ExecStart="/opt/daedalus-agent/bin/daedalus-agent" run
Restart=always
RestartSec=3
TimeoutStopSec=20
UMask=0022
NoNewPrivileges=yes
ProtectSystem=full
ProtectHome=read-only
PrivateTmp=yes
ProtectKernelTunables=yes
ProtectKernelModules=yes
ProtectControlGroups=yes
RestrictSUIDSGID=yes
RestrictRealtime=yes
LockPersonality=yes

[Install]
WantedBy=multi-user.target
"#
        );
    }

    #[test]
    fn the_session_unit_is_this_text() {
        assert_eq!(
            session_unit(Path::new(EXE)),
            r#"[Unit]
Description=Daedalus Agent session: Claude Code remote control for this user
Documentation=https://github.com/santiagotoscanini/daedalus/tree/main/agent

[Service]
Type=simple
ExecStart="/opt/daedalus-agent/bin/daedalus-agent" session
Restart=always
RestartSec=5

[Install]
WantedBy=default.target
"#
        );
    }

    #[test]
    fn the_autostart_entry_is_this_text() {
        assert_eq!(
            autostart_entry(Path::new("/opt/daedalus-agent/bin/daedalus-agent-tray")),
            r#"[Desktop Entry]
Type=Application
Name=Daedalus Agent
Comment=This machine as the box sees it: the awake hold, updates, Claude remote control
Exec="/opt/daedalus-agent/bin/daedalus-agent-tray"
Terminal=false
NoDisplay=true
X-GNOME-Autostart-enabled=true
"#
        );
        // The entry parses as the desktop entry the inventory reads.
        let e =
            crate::telemetry::parse::linux_sys::desktop_entry(&autostart_entry(Path::new("/x")))
                .unwrap();
        assert!(e.application && e.hidden);
    }

    #[test]
    fn paths_with_spaces_and_specials_are_quoted_per_each_format() {
        let odd = Path::new("/opt/My Agent/50% \"x\" $HOME\\bin/daedalus-agent");
        let unit = session_unit(odd);
        assert!(
            unit.contains(
                "ExecStart=\"/opt/My Agent/50%% \\\"x\\\" $$HOME\\\\bin/daedalus-agent\" session\n"
            ),
            "{unit}"
        );
        let entry = autostart_entry(Path::new("/opt/My Tray/a`b$c\\d%e"));
        assert!(
            entry.contains("Exec=\"/opt/My Tray/a\\\\`b\\\\$c\\\\\\\\d%%e\"\n"),
            "{entry}"
        );
        assert_eq!(systemd_quote("/a b"), "\"/a b\"");
        assert_eq!(desktop_quote("/a b"), "\"/a b\"");
    }

    #[test]
    fn the_systemd_version_and_its_floor() {
        assert_eq!(
            systemd_version("systemd 252 (252.22-1~deb12u1)\n+PAM +AUDIT"),
            Some(252)
        );
        assert_eq!(systemd_version("systemd 239\n"), Some(239));
        assert_eq!(systemd_version("nonsense"), None);
    }

    #[test]
    fn the_install_directory_must_be_roots_and_closed_to_writers() {
        assert_eq!(dir_is_safe(0, 0o40755), Ok(()));
        assert!(dir_is_safe(1000, 0o40755).is_err());
        assert!(dir_is_safe(0, 0o40775).is_err());
        assert!(dir_is_safe(0, 0o40757).is_err());
        assert!(dir_is_safe(0, 0o40700).is_err());
    }

    #[test]
    fn the_session_record_round_trips() {
        let r = SessionUser {
            user: "ana".into(),
            uid: 1000,
            enabled_linger: true,
        };
        let text = serde_json::to_string(&r).unwrap();
        assert_eq!(serde_json::from_str::<SessionUser>(&text).unwrap(), r);
    }
}
