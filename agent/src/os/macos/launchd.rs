//! The macOS side of `install`, `uninstall` and `run` — macOS's `os::svc`:
//! two launchd jobs, both running from Daedalus Agent.app in its fixed,
//! root-only place (bundle.rs).
//!
//!   /Library/LaunchDaemons/me.toscanini.daedalus-agent.plist
//!       the service, as root, at boot, kept alive — `daedalus-agent run`
//!   /Library/LaunchAgents/me.toscanini.daedalus-agent-tray.plist
//!       the menu bar app, in every user's Aqua session, kept alive
//!
//! Both carry `AssociatedBundleIdentifiers`, so Login Items lists them
//! under the app's name and team. Root for the same two reasons as
//! LocalSystem on Windows: the power assertion should outlive any login,
//! and the updater replaces the bundle. The file layout is in
//! agent/README.md, "On the machine".
//!
//! `install` runs from a bundle — the one the user opened (the menu bar
//! app's first open, behind one administrator prompt), or the one
//! install.sh unpacked — and puts a sealed copy of it in place the way an
//! update does (bundle.rs). An update exchanges the bundle and exits;
//! launchd's KeepAlive brings the service back on the new one, which
//! kickstarts the menu bar app onto it too.
//!
//! `run` is `agent_main` with SIGTERM as the stop: launchd sends it on
//! `bootout` and at shutdown (the relay is unix.rs's `on_interrupt`).

use crate::util::Shutdown;
use std::os::unix::fs::{MetadataExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};

use super::bundle;
use crate::config::{self, Config};
use crate::paths;

pub const DAEMON_LABEL: &str = "me.toscanini.daedalus-agent";
pub const TRAY_LABEL: &str = "me.toscanini.daedalus-agent-tray";

pub fn daemon_plist() -> PathBuf {
    PathBuf::from(format!("/Library/LaunchDaemons/{DAEMON_LABEL}.plist"))
}

pub fn tray_plist() -> PathBuf {
    PathBuf::from(format!("/Library/LaunchAgents/{TRAY_LABEL}.plist"))
}

/// The terminal's `daedalus-agent`.
const CLI_LINK: &str = "/usr/local/bin/daedalus-agent";

/// The oldest macOS the app runs on (Info.plist's LSMinimumSystemVersion):
/// Ventura, whose Login Items lists legacy jobs by their app.
const MIN_MACOS: u64 = 13;

/// launchd's KeepAlive restarts the menu bar app, and `run` kickstarts it
/// at every start; the service does not watch it besides.
pub const WATCHES_TRAY: bool = false;

/// `daedalus-agent run` under launchd: the agent until SIGTERM or SIGINT.
pub fn run_service() -> Result<()> {
    let stop = Shutdown::new();
    let relay = stop.clone();
    super::on_interrupt(move || relay.stop());
    if is_root() {
        converge_permissions();
        // A moment later, once agent_main has opened the log, so the
        // outcome is recorded.
        std::thread::spawn(|| {
            std::thread::sleep(std::time::Duration::from_secs(3));
            kickstart_tray();
        });
    }
    crate::service::agent_main(stop, false)
}

fn is_root() -> bool {
    // SAFETY: no arguments.
    unsafe { libc::geteuid() == 0 }
}

/// `launchctl` for install and uninstall: what `launchctl_timeout` does,
/// with time for a bootstrap of the daemon.
fn launchctl(args: &[&str]) -> Result<()> {
    launchctl_timeout(args, 30).map(drop)
}

/// A job's plist. `log` takes its stdout and stderr; the menu bar app has
/// none: it logs into its user's own directory (session.rs), and a fixed
/// path here would be one file every user's menu bar app shares.
fn plist(label: &str, program: &Path, args: &[&str], log: Option<&Path>, agent: bool) -> String {
    let mut argv = format!("      <string>{}</string>\n", program.display());
    for a in args {
        argv.push_str(&format!("      <string>{a}</string>\n"));
    }
    let log = log
        .map(|l| {
            format!(
                "    <key>StandardOutPath</key>\n    <string>{l}</string>\n    <key>StandardErrorPath</key>\n    <string>{l}</string>\n",
                l = l.display()
            )
        })
        .unwrap_or_default();
    // The LaunchAgent loads only into Aqua (GUI login) sessions and runs as
    // Interactive, so launchd does not throttle it like a background job;
    // the daemon is Background.
    let session = if agent {
        "    <key>LimitLoadToSessionType</key>\n    <string>Aqua</string>\n    <key>ProcessType</key>\n    <string>Interactive</string>\n"
    } else {
        "    <key>ProcessType</key>\n    <string>Background</string>\n"
    };
    format!(
        r#"<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
  <dict>
    <key>Label</key>
    <string>{label}</string>
    <key>ProgramArguments</key>
    <array>
{argv}    </array>
    <key>AssociatedBundleIdentifiers</key>
    <array>
      <string>{app}</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>ThrottleInterval</key>
    <integer>5</integer>
{session}{log}  </dict>
</plist>
"#,
        app = bundle::BUNDLE_ID,
    )
}

/// The uid of whoever owns the console — the logged-in user — for loading
/// the tray into their session right now rather than at their next login.
fn console_uid() -> Option<u32> {
    std::fs::metadata("/dev/console").ok().map(|m| m.uid())
}

/// What `install` takes beyond `sudo` (the verb's options).
#[derive(Debug, Default)]
pub struct Options {
    /// Whom the app's first open installs for (`--installer-uid`, its own
    /// uid): the user at the console. Under `sudo` the user is sudo's
    /// (`SUDO_USER`), and this is refused.
    pub installer_uid: Option<u32>,
    /// Let this install change the recorded operator (`--replace-operator`):
    /// who that is decides who gets santree's shell on the box, so it never
    /// changes silently.
    pub replace_operator: bool,
}

/// `os::svc::install`: `install_with` and no options.
pub fn install(cfg: &Config) -> Result<()> {
    install_with(cfg, &Options::default())
}

/// `daedalus-agent install`, run as root from inside a Daedalus Agent.app:
/// that bundle copied, sealed and checked in the slot's stage, then put in
/// place (bundle.rs); the terminal's link, the config, the operator's record, both jobs written and started.
/// Idempotent: from the installed bundle itself nothing is copied, and the
/// jobs are rewritten and restarted. config.toml is left as it is.
pub fn install_with(cfg: &Config, opts: &Options) -> Result<()> {
    if !is_root() {
        bail!("install needs root: open Daedalus Agent.app, or run it with sudo");
    }
    require_macos()?;
    let source = bundle::running_app().context(
        "install runs from Daedalus Agent.app (open the app, or use install.sh): \
         this binary is not inside one",
    )?;
    let sudo = sudo_user()?;
    let app = opts.installer_uid.map(|uid| (uid, account_of_uid(uid)));
    let operator = operator_for(
        sudo,
        app,
        console_uid(),
        installer_uid(),
        opts.replace_operator,
    )?;
    ensure_home()?;

    let slot = bundle::slot();
    let fresh = std::fs::canonicalize(bundle::canonical()).ok() != Some(source.clone());
    if fresh {
        let staged = bundle::stage_copy(&source, &slot)?;
        bundle::seal(&staged)?;
        bundle::check(&staged, &crate_version(), false).with_context(|| {
            format!("{} is not a whole bundle of this version", source.display())
        })?;
    }

    // Everything that runs stops before the bundle moves, the menu bar app
    // first; both start again below.
    if let Some(uid) = console_uid().filter(|u| *u != 0) {
        let _ = launchctl(&["bootout", &format!("gui/{uid}/{TRAY_LABEL}")]);
    }
    let _ = launchctl(&["bootout", &format!("system/{DAEMON_LABEL}")]);
    if fresh {
        if let Err(e) = slot.swap_in() {
            // Nothing moved: what was installed starts again as it was.
            for (domain, plist) in [
                ("system".to_string(), daemon_plist()),
                (format!("gui/{}", console_uid().unwrap_or(0)), tray_plist()),
            ] {
                if plist.exists() && !domain.ends_with("/0") {
                    let _ = launchctl(&["bootstrap", &domain, &plist.to_string_lossy()]);
                }
            }
            return Err(e);
        }
        println!(
            "{} installed from {}",
            bundle::canonical().display(),
            source.display()
        );
    }
    slot.retire();
    // An update on probation is over: this is the version the operator put
    // here.
    let mut state = crate::state::State::load();
    if state.probation.take().is_some() {
        state.save();
    }
    link_cli();

    std::fs::create_dir_all(paths::log_dir()).context("creating the log directory")?;
    let path = config::write_for_install(cfg)?;
    converge_permissions();
    println!("config at {}", path.display());
    match &operator {
        Some(who) => {
            write_installer(who)?;
            println!(
                "santree's socket and the log-in serve {} (uid {}) and root",
                who.user, who.uid
            );
        }
        None => println!("no user named: the operator recorded before stays, or root alone"),
    }

    let canonical = bundle::canonical();
    crate::util::write_atomic(
        &daemon_plist(),
        plist(
            DAEMON_LABEL,
            &bundle::service_exe(&canonical),
            &["run"],
            Some(&paths::log_dir().join("launchd.log")),
            false,
        )
        .as_bytes(),
        crate::util::Access::Mode(0o644),
    )
    .context("writing the daemon's plist")?;
    crate::util::write_atomic(
        &tray_plist(),
        plist(TRAY_LABEL, &bundle::tray_exe(&canonical), &[], None, true).as_bytes(),
        crate::util::Access::Mode(0o644),
    )
    .context("writing the tray's plist")?;
    converge_permissions();
    launchctl(&["bootstrap", "system", &daemon_plist().to_string_lossy()])?;
    println!("service {DAEMON_LABEL} registered and started");
    match console_uid().filter(|u| *u != 0) {
        Some(uid) => match launchctl(&[
            "bootstrap",
            &format!("gui/{uid}"),
            &tray_plist().to_string_lossy(),
        ]) {
            Ok(()) => println!("menu bar app registered for every login and started for uid {uid}"),
            Err(e) => println!("menu bar app registered for every login; not started now: {e}"),
        },
        None => println!("menu bar app registered for every login"),
    }
    Ok(())
}

/// This build's version, as releases are compared (no build metadata).
fn crate_version() -> semver::Version {
    let v = semver::Version::parse(crate::VERSION).expect("the version is semver");
    semver::Version {
        build: semver::BuildMetadata::EMPTY,
        ..v
    }
}

/// macOS 13 or newer (`MIN_MACOS`), as Info.plist and install.sh say.
fn require_macos() -> Result<()> {
    let v = super::os_version();
    let major: u64 = v
        .split('.')
        .next()
        .and_then(|m| m.parse().ok())
        .with_context(|| format!("reading the macOS version {v:?}"))?;
    if major < MIN_MACOS {
        bail!("Daedalus Agent needs macOS {MIN_MACOS} or newer; this Mac runs {v}");
    }
    Ok(())
}

/// The canonical bundle's folder: root's own, closed to writers, in a
/// parent root owns and no one else can write (bundle.rs). Made when
/// absent; its mode set when root owns it; refused otherwise.
fn ensure_home() -> Result<()> {
    let home = bundle::home();
    for dir in home.ancestors().skip(1).filter(|p| p != &Path::new("/")) {
        let m = std::fs::metadata(dir).with_context(|| format!("reading {}", dir.display()))?;
        if m.uid() != 0 || m.mode() & 0o022 != 0 {
            bail!(
                "{} is not root's alone; the service would run from under it",
                dir.display()
            );
        }
    }
    match std::fs::symlink_metadata(&home) {
        Ok(m) if m.is_dir() && m.uid() == 0 => {}
        Ok(_) => bail!("{} is not a directory of root's", home.display()),
        Err(_) => {
            std::fs::create_dir(&home).with_context(|| format!("creating {}", home.display()))?
        }
    }
    std::fs::set_permissions(&home, std::fs::Permissions::from_mode(0o755))
        .with_context(|| format!("setting {}'s mode", home.display()))
}

/// `daedalus-agent` in /usr/local/bin, a link to the canonical service.
fn link_cli() {
    let target = bundle::service_exe(&bundle::canonical());
    let link = Path::new(CLI_LINK);
    let placed = (|| -> std::io::Result<()> {
        std::fs::create_dir_all(link.parent().expect("a directory"))?;
        let tmp = link.with_extension("new");
        let _ = std::fs::remove_file(&tmp);
        std::os::unix::fs::symlink(&target, &tmp)?;
        std::fs::rename(&tmp, link)
    })();
    if let Err(e) = placed {
        println!(
            "{CLI_LINK} not linked ({e}); the command is {}",
            target.display()
        );
    }
}

/// Whether the terminal's link is ours: it names something in the bundle's
/// home.
fn cli_link_is_ours() -> bool {
    std::fs::read_link(CLI_LINK).is_ok_and(|t| t.starts_with(bundle::home()))
}

/// `os::svc::uninstall`: stop and remove both jobs and the operator's
/// record; the bundle, config and identity stay (`uninstall_app` removes
/// the bundle too).
pub fn uninstall() -> Result<()> {
    if !is_root() {
        bail!("uninstall needs root: sudo daedalus-agent uninstall");
    }
    remove_jobs_and_record()?;
    println!("service and menu bar app removed; the app and the data directory stay");
    stop_user_jobs();
    Ok(())
}

/// `daedalus-agent uninstall --app` (the menu bar's "Uninstall…", behind
/// the administrator prompt): this Mac logged out of the box — so the box
/// forgets its tunnel — then the service stopped and everything it put
/// here removed but the data directory: the jobs, the operator's record,
/// the terminal's link, the app in its place and in /Applications. The
/// identity stays, so a re-install is the same machine. The menu bar app
/// that asked goes last, and this process leaves its session first, so
/// ending it does not end this.
pub fn uninstall_app() -> Result<()> {
    if !is_root() {
        bail!("uninstall needs root: sudo daedalus-agent uninstall --app");
    }
    // SAFETY: no arguments; failing (already a group leader) is harmless.
    unsafe {
        libc::setsid();
    }
    match crate::local::call_within::<String>(
        &crate::local::LocalRequest::EnrollLeave,
        crate::local::ENROLL_DEADLINE,
    ) {
        Ok(_) => println!("logged out of the box"),
        Err(e) => {
            println!("not logged out ({e}); the box can revoke this Mac in Settings › Machines")
        }
    }
    remove_jobs_and_record()?;
    if cli_link_is_ours() {
        let _ = std::fs::remove_file(CLI_LINK);
    }
    let slot = bundle::slot();
    for p in [slot.live.clone(), slot.work.clone()] {
        crate::update::remove(&p)?;
    }
    let dragged = Path::new(bundle::APPLICATIONS_COPY);
    if bundle::info(dragged).is_ok_and(|i| i.id == bundle::BUNDLE_ID) {
        crate::update::remove(dragged)?;
    }
    println!(
        "Daedalus Agent removed; its data stays in {}",
        bundle::home().display()
    );
    stop_user_jobs();
    Ok(())
}

/// The daemon stopped, both plists and the operator's record removed.
fn remove_jobs_and_record() -> Result<()> {
    let _ = launchctl(&["bootout", &format!("system/{DAEMON_LABEL}")]);
    for p in [daemon_plist(), tray_plist()] {
        if p.exists() {
            std::fs::remove_file(&p).with_context(|| format!("removing {}", p.display()))?;
        }
    }
    let _ = std::fs::remove_file(installer_record());
    Ok(())
}

/// The console user's jobs: Claude remote control — a job of the user's own
/// (os/macos/jobs.rs) that outlives the menu bar app; sessions it resumed
/// run on until they end or the user logs out — then the menu bar app.
fn stop_user_jobs() {
    if let Some(uid) = console_uid().filter(|u| *u != 0) {
        let rc = crate::jobs::launchd_label(&paths::claude_unit_name());
        let _ = launchctl(&["bootout", &format!("gui/{uid}/{rc}")]);
        let _ = launchctl(&["bootout", &format!("gui/{uid}/{TRAY_LABEL}")]);
    }
}

/// What the user's processes must be able to read. Root made the tree
/// under whatever umask `sudo sh` had — 077 on some Macs — and the tray
/// runs as the user: it has to traverse the data directory to the bundle
/// and read config.toml, and launchd has to read the plists. Run at
/// install AND at every service start. The bundle's own modes are set when
/// it is sealed (bundle.rs); the identity key stays root's alone (0600,
/// `util::write_atomic`, private).
pub fn converge_permissions() {
    // config.toml's directory is the data directory unless `data_dir`
    // moved the rest (config.rs); both are converged.
    let dirs = [paths::config_dir(), paths::data_dir(), paths::log_dir()];
    let files = [
        paths::config_path(),
        paths::state_path(),
        daemon_plist(),
        tray_plist(),
    ];
    for (p, mode) in dirs
        .iter()
        .map(|p| (p, 0o755))
        .chain(files.iter().map(|p| (p, 0o644)))
    {
        if p.exists() {
            let _ = std::fs::set_permissions(p, std::fs::Permissions::from_mode(mode));
        }
    }
}

/// `launchctl` with a deadline: `kickstart` on a job in "spawn scheduled"
/// blocks forever (0.5.2 leaked one hung root child per daemon start), and
/// nothing here is worth waiting on for more than a few seconds.
fn launchctl_timeout(args: &[&str], secs: u64) -> Result<String> {
    let mut cmd = Command::new("/bin/launchctl");
    cmd.args(args);
    crate::exec::stdout_or(
        cmd,
        std::time::Duration::from_secs(secs),
        crate::exec::Text::Lossy,
    )
    .map_err(|e| anyhow::anyhow!("launchctl {}: {e}", args.join(" ")))
}

/// `os::svc`'s tray start: `kickstart_tray`, whose outcome is logged, not
/// returned.
pub fn launch_tray_or_session() -> Result<()> {
    kickstart_tray();
    Ok(())
}

/// Someone is at the console: a menu bar app should be reporting
/// (update/, probation).
pub fn interactive_user() -> bool {
    console_uid().is_some_and(|u| u != 0)
}

/// After an update: the console user's menu bar app started again on the
/// new binary (`kickstart -k` kills and restarts the job; Claude runs on in
/// its own jobs). Nothing without a console user.
pub fn restart_desktop_side() {
    let Some(uid) = console_uid().filter(|u| *u != 0) else {
        return;
    };
    let target = format!("gui/{uid}/{TRAY_LABEL}");
    match launchctl_timeout(&["kickstart", "-k", &target], 10) {
        Ok(_) => tracing::info!(uid, "menu bar app restarted on the new version"),
        Err(e) => tracing::warn!(uid, error = %e, "menu bar app not restarted"),
    }
}

/// Start the menu bar app in the console user's session if it is not
/// running (`start_tray`). The daemon does this at every start.
pub fn kickstart_tray() {
    let Some(uid) = console_uid().filter(|u| *u != 0) else {
        tracing::info!("no console user; the menu bar app starts at the next login");
        return;
    };
    match start_tray(uid) {
        Ok(true) => tracing::info!(uid, "menu bar app loaded into the console session"),
        Ok(false) => {}
        Err(e) => tracing::warn!(uid, error = %format!("{e:#}"), "menu bar app not loaded"),
    }
}

/// The menu bar app started in `uid`'s gui domain unless it runs there
/// already: the daemon's at each start, and the app's when it is opened
/// with the agent installed (as that user, in their own domain). launchd
/// gives up on a job whose spawn failed (a root-only tree did that to every
/// 0.5.0 install), so a job without a pid is booted out — which clears its
/// stale failure — and bootstrapped again, which starts it. True when it
/// was started.
pub fn start_tray(uid: u32) -> Result<bool> {
    if !tray_plist().exists() {
        bail!("{} is not installed", tray_plist().display());
    }
    let domain = format!("gui/{uid}");
    let target = format!("{domain}/{TRAY_LABEL}");
    let running = launchctl_timeout(&["print", &target], 5)
        .map(|text| text.lines().any(|l| l.trim().starts_with("pid = ")))
        .unwrap_or(false);
    if running {
        return Ok(false);
    }
    let _ = launchctl_timeout(&["bootout", &target], 10);
    launchctl_timeout(&["bootstrap", &domain, &tray_plist().to_string_lossy()], 10)?;
    Ok(true)
}

/// Who installed the agent — the operator: the user `sudo` ran `install`
/// for, or whom the app's first open installed for. santree's socket and
/// the log-in serve that user and root, and nobody else
/// (`super::operator_allowed`).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Installer {
    pub user: String,
    pub uid: u32,
}

fn installer_record() -> PathBuf {
    paths::data_dir().join("installer.json")
}

fn write_installer(who: &Installer) -> Result<()> {
    let text = serde_json::to_string_pretty(who)?;
    crate::util::write_atomic(
        &installer_record(),
        text.as_bytes(),
        crate::util::Access::Mode(0o644),
    )
    .context("writing installer.json")
}

/// `SUDO_USER` (`curl … | sudo sh` passes it to `install`) with its uid;
/// None without one — a reinstall from root's own shell keeps the record
/// there is.
fn sudo_user() -> Result<Option<Installer>> {
    let Some(user) = std::env::var("SUDO_USER")
        .ok()
        .filter(|u| !u.is_empty() && u != "root")
    else {
        return Ok(None);
    };
    let (uid, _) = account_of_name(&user).with_context(|| format!("no account {user}"))?;
    Ok(Some(Installer { user, uid }))
}

/// An account's name and home directory, from its uid.
pub fn account_of_uid(uid: u32) -> Option<(String, PathBuf)> {
    passwd(&|pw, buf, out| {
        // SAFETY: getpwuid_r writes into `pw` and `buf`, both ours and
        // sized as passed; `out` points at `pw` or is null.
        unsafe { libc::getpwuid_r(uid, pw, buf.as_mut_ptr(), buf.len(), out) }
    })
    .map(|(name, _, home)| (name, home))
}

/// An account's uid and home directory, from its name.
fn account_of_name(name: &str) -> Option<(u32, PathBuf)> {
    let c = std::ffi::CString::new(name).ok()?;
    passwd(&|pw, buf, out| {
        // SAFETY: as above, with a NUL-terminated name that outlives the call.
        unsafe { libc::getpwnam_r(c.as_ptr(), pw, buf.as_mut_ptr(), buf.len(), out) }
    })
    .map(|(_, uid, home)| (uid, home))
}

type Lookup<'a> =
    dyn Fn(*mut libc::passwd, &mut [libc::c_char], *mut *mut libc::passwd) -> libc::c_int + 'a;

fn passwd(lookup: &Lookup<'_>) -> Option<(String, u32, PathBuf)> {
    use std::ffi::CStr;
    use std::os::unix::ffi::OsStrExt;
    // SAFETY: an all-zero passwd is a valid value to be written over.
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut buf = vec![0 as libc::c_char; 4096];
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    if lookup(&mut pw, &mut buf, &mut out) != 0 || out.is_null() {
        return None;
    }
    // SAFETY: on success both strings point into `buf`, NUL-terminated.
    let (name, home) = unsafe { (CStr::from_ptr(pw.pw_name), CStr::from_ptr(pw.pw_dir)) };
    Some((
        name.to_string_lossy().into_owned(),
        pw.pw_uid,
        PathBuf::from(std::ffi::OsStr::from_bytes(home.to_bytes())),
    ))
}

/// Whom this install records as the operator (review S3):
///
/// - under `sudo`, its user (`sudo`), as always; `--installer-uid` is then
///   refused — sudo names the user itself;
/// - from the app, `--installer-uid`: an account of a person (uid 501 and
///   up, with a home directory) that is the user at the console — the app
///   is always opened by a click there, and the administrator prompt said
///   whom it installs for;
/// - neither: nobody new; the record there is stays.
///
/// A record naming someone else is never replaced silently: that hands
/// santree's shell on the box to another account, so it takes
/// `--replace-operator` (or an uninstall first).
fn operator_for(
    sudo: Option<Installer>,
    app: Option<(u32, Option<(String, PathBuf)>)>,
    console: Option<u32>,
    recorded: Option<u32>,
    replace: bool,
) -> Result<Option<Installer>> {
    let chosen = match (sudo, app) {
        (Some(_), Some(_)) => {
            bail!("--installer-uid is the app's: under sudo the installing user is sudo's")
        }
        (None, Some((uid, account))) => {
            if uid < 501 {
                bail!("uid {uid} is not a person's account (those start at 501)");
            }
            let Some((user, _)) = account.filter(|(_, home)| home.is_dir()) else {
                bail!("uid {uid} has no account with a home directory");
            };
            if console != Some(uid) {
                bail!(
                    "uid {uid} is not the user at the console: the app installs for whoever opened it"
                );
            }
            Some(Installer { user, uid })
        }
        (sudo, None) => sudo,
    };
    if let (Some(who), Some(was)) = (&chosen, recorded) {
        if who.uid != was && !replace {
            bail!(
                "this Mac's agent serves uid {was}; installing for {} (uid {}) would hand \
                 santree's shell on the box to them. Uninstall first, or install again with \
                 --replace-operator",
                who.user,
                who.uid
            );
        }
    }
    Ok(chosen)
}

/// The uid `install` recorded; None without a record, or with one root (or
/// this user) did not write.
pub fn installer_uid() -> Option<u32> {
    installer_uid_at(&installer_record())
}

fn installer_uid_at(path: &Path) -> Option<u32> {
    let text = std::fs::read_to_string(path).ok()?;
    crate::private::check_owner(path).ok()?;
    serde_json::from_str::<Installer>(&text).ok().map(|r| r.uid)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_installer_is_read_from_its_record() {
        let dir = std::env::temp_dir().join(format!("daedalus-installer-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("installer.json");
        assert_eq!(installer_uid_at(&path), None);
        std::fs::write(&path, r#"{"user":"alice","uid":501}"#).unwrap();
        assert_eq!(installer_uid_at(&path), Some(501));
        std::fs::write(&path, "not json").unwrap();
        assert_eq!(installer_uid_at(&path), None);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_operator_is_sudos_user_or_the_console_user_the_app_named() {
        let home = std::env::temp_dir();
        let alice = || Installer {
            user: "alice".into(),
            uid: 501,
        };
        let account = |name: &str| Some((name.to_string(), home.clone()));
        let pick = operator_for;
        // sudo: its user, whoever holds the console (an ssh install).
        assert_eq!(
            pick(Some(alice()), None, None, None, false).unwrap(),
            Some(alice())
        );
        // The app: the console user it named.
        assert_eq!(
            pick(None, Some((501, account("alice"))), Some(501), None, false).unwrap(),
            Some(alice())
        );
        // Neither: nobody new.
        assert_eq!(pick(None, None, Some(501), Some(502), false).unwrap(), None);
        // Both at once, a system account, no account, no home, not the
        // console's: refused.
        let app = || Some((501, account("alice")));
        assert!(pick(Some(alice()), app(), Some(501), None, false).is_err());
        assert!(pick(None, Some((0, account("root"))), Some(0), None, false).is_err());
        assert!(pick(None, Some((499, account("_svc"))), Some(499), None, false).is_err());
        assert!(pick(None, Some((501, None)), Some(501), None, false).is_err());
        let homeless = Some(("alice".to_string(), PathBuf::from("/nonexistent/alice")));
        assert!(pick(None, Some((501, homeless)), Some(501), None, false).is_err());
        assert!(pick(None, app(), Some(502), None, false).is_err());
        assert!(pick(None, app(), None, None, false).is_err());
        // Another operator on record: only with --replace-operator.
        assert!(pick(Some(alice()), None, None, Some(502), false).is_err());
        assert!(pick(None, app(), Some(501), Some(502), false).is_err());
        assert_eq!(
            pick(Some(alice()), None, None, Some(502), true).unwrap(),
            Some(alice())
        );
        // The same one again: nothing to replace.
        assert_eq!(
            pick(Some(alice()), None, None, Some(501), false).unwrap(),
            Some(alice())
        );
    }

    #[test]
    fn both_jobs_run_from_the_bundle_and_name_the_app() {
        let app = bundle::canonical();
        let daemon = plist(
            DAEMON_LABEL,
            &bundle::service_exe(&app),
            &["run"],
            Some(Path::new("/l")),
            false,
        );
        assert!(daemon.contains(
            "<string>/Library/Application Support/daedalus-agent/Daedalus Agent.app/Contents/MacOS/daedalus-agent</string>"
        ));
        assert!(daemon.contains(
            "<key>AssociatedBundleIdentifiers</key>\n    <array>\n      <string>me.toscanini.daedalus-agent-tray</string>"
        ));
        let tray = plist(TRAY_LABEL, &bundle::tray_exe(&app), &[], None, true);
        assert!(daemon.contains("<key>StandardErrorPath</key>\n    <string>/l</string>"));
        // No log shared by every user's menu bar app.
        assert!(!tray.contains("StandardOutPath") && !tray.contains("/tmp/"));
        assert!(tray.contains("Daedalus Agent.app/Contents/MacOS/daedalus-agent-tray</string>"));
        assert!(tray.contains("<string>Aqua</string>"));
        assert!(!tray.contains("/Applications/"));
    }
}
