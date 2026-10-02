//! Lemonade on Windows: the MSI, per-user by default
//! (`%LOCALAPPDATA%\lemonade_server`, recorded under
//! `HKCU\Software\AMD\Lemonade Server`), per-machine with `ALLUSERS=1`
//! (under HKLM). The server lives in the tray, `bin\LemonadeServer.exe`,
//! and reads models and settings from the profile that runs it — so it
//! serves only while its user is logged on, and everything here acts in
//! the console user's session, with that user's token (service.rs
//! `as_console_user`), never as SYSTEM:
//!
//! - **find**: the console user's hive first, then HKLM; an install in
//!   another logged-on user's hive is `foreign`. The process by its image
//!   name, with its session and account. Startup: the Startup-folder
//!   shortcut, and Explorer's `StartupApproved\StartupFolder` value for it
//!   (in the user's hive, or HKLM for the all-users folder) — what Task
//!   Manager's switch writes, and what survives the shortcut every upgrade
//!   reinstalls.
//! - **install**: msiexec, quiet, logged, in the user's session for a
//!   per-user install — an upgrade force-kills the server and relaunches
//!   it as whoever ran msiexec — and as SYSTEM for a per-machine one, which
//!   a user's filtered token could not elevate to; the server the MSI then
//!   relaunches outside the user's session is moved into it by the
//!   install's verification. Another install running (1618) is waited out.
//! - **start**: `LemonadeServer.exe --silent` in the session; a second one
//!   exits 0 at once on `Global\LemonadeRouterMutex`, so the caller
//!   confirms by the server's answer. **stop**: `/internal/shutdown`.

use std::path::{Path, PathBuf};
use std::time::Duration;

use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::ConvertStringSidToSidW;
use windows::Win32::Security::{LookupAccountSidW, PSID, SID_NAME_USE, TOKEN_QUERY};
use windows::Win32::System::Registry::{
    RegGetValueW, RegSetKeyValueW, HKEY, HKEY_LOCAL_MACHINE, HKEY_USERS, REG_BINARY,
    RRF_RT_REG_BINARY,
};
use windows::Win32::System::RemoteDesktop::{ProcessIdToSessionId, WTSGetActiveConsoleSessionId};
use windows::Win32::System::Threading::{
    OpenProcess, OpenProcessToken, PROCESS_QUERY_LIMITED_INFORMATION,
};

use super::telemetry::browsers::{console_sid_from_token, logged_on_sids, token_user_sid};
use super::telemetry::processes::process_snapshot;
use super::telemetry::registry::{reg_key_exists_at, reg_sz_at};
use super::telemetry::{from_wide, wide};
use crate::node::providers::host::{
    msi_exit, msiexec_args, startup_approved, startup_value, Msi, MsiExit, MSI_BUSY_BACKOFF,
};
use crate::node::providers::{
    Console, Found, ProviderInstall, ProviderInstallMethod, ProviderInstallScope, ProviderStartup,
};

/// The installers this OS takes.
pub const INSTALLERS: &[&str] = &["msi"];

const KEY: &str = r"Software\AMD\Lemonade Server";
const SERVER_EXE: &str = "LemonadeServer.exe";
const SHORTCUT: &str = "Lemonade Server.lnk";
const APPROVED: &str =
    r"Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\StartupFolder";
/// The most one msiexec run may take.
const MSIEXEC: Duration = Duration::from_secs(20 * 60);

/// `DOMAIN\user` for a string SID, when it resolves.
fn account_of(sid: &str) -> Option<String> {
    let text = wide(sid);
    let mut psid = PSID::default();
    // SAFETY: the SID is converted, looked up into buffers of the asked
    // size, and freed.
    unsafe {
        ConvertStringSidToSidW(PCWSTR(text.as_ptr()), &mut psid).ok()?;
        let mut name = [0u16; 256];
        let mut domain = [0u16; 256];
        let (mut n, mut d) = (name.len() as u32, domain.len() as u32);
        let mut kind = SID_NAME_USE::default();
        let looked = LookupAccountSidW(
            PCWSTR::null(),
            psid,
            Some(PWSTR(name.as_mut_ptr())),
            &mut n,
            Some(PWSTR(domain.as_mut_ptr())),
            &mut d,
            &mut kind,
        );
        let _ = LocalFree(Some(HLOCAL(psid.0)));
        looked.ok()?;
        let name = from_wide(&name)?;
        Some(match from_wide(&domain) {
            Some(dom) => format!(r"{dom}\{name}"),
            None => name,
        })
    }
}

/// The console session and its user; None while nobody is logged on.
fn console() -> Option<Console> {
    // SAFETY: a plain query.
    let session = unsafe { WTSGetActiveConsoleSessionId() };
    if session == 0xFFFF_FFFF {
        return None;
    }
    let sid = console_sid_from_token()?;
    Some(Console {
        session,
        user: account_of(&sid),
        sid,
    })
}

/// A string value under a root and subkey.
fn sz(root: HKEY, sub: &str, value: &str) -> Option<String> {
    let (s, v) = (wide(sub), wide(value));
    reg_sz_at(root, PCWSTR(s.as_ptr()), PCWSTR(v.as_ptr()))
}

/// The install recorded under `root\sub`, if any.
fn install_at(root: HKEY, sub: &str, scope: ProviderInstallScope) -> Option<ProviderInstall> {
    let key = wide(sub);
    if !reg_key_exists_at(root, PCWSTR(key.as_ptr())) {
        return None;
    }
    Some(ProviderInstall {
        method: ProviderInstallMethod::Msi,
        scope,
        location: sz(root, sub, "InstallLocation"),
        installer_version: sz(root, sub, "Version"),
        user: None,
    })
}

/// A user's value from their `Volatile Environment` (what logon wrote).
fn user_env(sid: &str, name: &str) -> Option<String> {
    sz(HKEY_USERS, &format!(r"{sid}\Volatile Environment"), name)
}

/// The process's session and account.
fn process_facts(pid: u32) -> (Option<u32>, Option<String>) {
    let mut session = 0u32;
    // SAFETY: a query into a u32; the process and token handles are closed.
    unsafe {
        let session = ProcessIdToSessionId(pid, &mut session)
            .ok()
            .map(|()| session);
        let owner = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
            .ok()
            .and_then(|p| {
                let mut token = HANDLE::default();
                let sid = OpenProcessToken(p, TOKEN_QUERY, &mut token)
                    .ok()
                    .and_then(|()| {
                        let sid = token_user_sid(token);
                        let _ = CloseHandle(token);
                        sid
                    });
                let _ = CloseHandle(p);
                sid
            })
            .map(|sid| account_of(&sid).unwrap_or(sid));
        (session, owner)
    }
}

/// A REG_BINARY value, when there is one.
fn binary(root: HKEY, sub: &str, value: &str) -> Option<Vec<u8>> {
    let (s, v) = (wide(sub), wide(value));
    let mut buf = [0u8; 64];
    let mut len = buf.len() as u32;
    // SAFETY: a read of at most 64 bytes into a 64-byte buffer.
    let rc = unsafe {
        RegGetValueW(
            root,
            PCWSTR(s.as_ptr()),
            PCWSTR(v.as_ptr()),
            RRF_RT_REG_BINARY,
            None,
            Some(buf.as_mut_ptr().cast()),
            Some(&mut len),
        )
    };
    rc.is_ok().then(|| buf[..len as usize].to_vec())
}

/// Where the startup shortcut and its approval live for this install:
/// the user's own Startup folder and hive, or the all-users ones.
fn startup_place(install: &ProviderInstall, c: &Console) -> Option<(PathBuf, HKEY, String)> {
    match install.scope {
        ProviderInstallScope::User => {
            let appdata = user_env(&c.sid, "APPDATA")?;
            Some((
                PathBuf::from(appdata)
                    .join(r"Microsoft\Windows\Start Menu\Programs\Startup")
                    .join(SHORTCUT),
                HKEY_USERS,
                format!(r"{}\{APPROVED}", c.sid),
            ))
        }
        ProviderInstallScope::Machine => {
            let pd = std::env::var_os("ProgramData")?;
            Some((
                PathBuf::from(pd)
                    .join(r"Microsoft\Windows\Start Menu\Programs\StartUp")
                    .join(SHORTCUT),
                HKEY_LOCAL_MACHINE,
                APPROVED.to_string(),
            ))
        }
    }
}

/// The install, the process and the startup, as this console user sees them.
pub fn find() -> Found {
    let mut found = Found {
        console: console(),
        ..Default::default()
    };
    if let Some(c) = &found.console {
        found.install = install_at(
            HKEY_USERS,
            &format!(r"{}\{KEY}", c.sid),
            ProviderInstallScope::User,
        )
        .map(|i| ProviderInstall {
            user: c.user.clone(),
            ..i
        });
    }
    if found.install.is_none() {
        found.install = install_at(HKEY_LOCAL_MACHINE, KEY, ProviderInstallScope::Machine);
    }
    if found.install.is_none() {
        let mine = found.console.as_ref().map(|c| c.sid.clone());
        if let Ok(sids) = logged_on_sids() {
            found.foreign = sids
                .into_iter()
                .filter(|s| Some(s) != mine.as_ref())
                .find(|s| {
                    install_at(
                        HKEY_USERS,
                        &format!(r"{s}\{KEY}"),
                        ProviderInstallScope::User,
                    )
                    .is_some()
                })
                .map(|s| account_of(&s).unwrap_or(s));
        }
    }
    match process_snapshot() {
        Ok(procs) => {
            let mut servers: Vec<(u32, Option<u32>, Option<String>)> = procs
                .into_iter()
                .filter(|(_, name)| name.eq_ignore_ascii_case(SERVER_EXE))
                .map(|(pid, _)| {
                    let (s, o) = process_facts(pid);
                    (pid, s, o)
                })
                .collect();
            // The one in the console session, when several run.
            let console_session = found.console.as_ref().map(|c| c.session);
            servers.sort_by_key(|(_, s, _)| *s != console_session);
            if let Some((pid, session, owner)) = servers.into_iter().next() {
                (found.pid, found.session, found.owner) = (Some(pid), session, owner);
            }
        }
        Err(e) => found.errors.push(e),
    }
    if let (Some(i), Some(c)) = (&found.install, &found.console) {
        if let Some((shortcut, root, sub)) = startup_place(i, c) {
            found.startup = Some(if !shortcut.is_file() {
                ProviderStartup::Missing
            } else {
                startup_approved(binary(root, &sub, SHORTCUT).as_deref())
            });
        }
    }
    found
}

/// Where msiexec writes its log: the user's own log directory for a run in
/// their session (they write it; the service only reads its tail, never
/// through a link), the service's for a per-machine run.
pub fn log_path(found: &Found) -> PathBuf {
    let per_user = found
        .install
        .as_ref()
        .is_none_or(|i| i.scope == ProviderInstallScope::User);
    let user_logs = found.console.as_ref().filter(|_| per_user).and_then(|c| {
        user_env(&c.sid, "LOCALAPPDATA")
            .map(|d| PathBuf::from(d).join(crate::SERVICE_NAME).join("logs"))
    });
    match user_logs {
        Some(dir) => {
            let _ = std::fs::create_dir_all(&dir);
            dir.join("lemonade-install.log")
        }
        None => crate::core::paths::log_dir().join("lemonade-install.log"),
    }
}

fn msiexec() -> PathBuf {
    std::env::var_os("SystemRoot")
        .map(PathBuf::from)
        .unwrap_or_else(|| "C:\\Windows".into())
        .join(r"System32\msiexec.exe")
}

/// One msiexec run to its end: its exit code.
fn msiexec_once(args: &[String], machine: bool) -> Result<u32, String> {
    if machine {
        let mut cmd = std::process::Command::new(msiexec());
        cmd.args(args);
        return match crate::exec::stdout_any(cmd, MSIEXEC, crate::exec::Text::Lossy) {
            Ok((code, _)) => Ok(code as u32),
            Err(e) => Err(format!("msiexec: {e}")),
        };
    }
    let line = std::iter::once(msiexec().display().to_string())
        .chain(args.iter().cloned())
        .map(|a| crate::jobs::windows_quote(&a))
        .collect::<Vec<_>>()
        .join(" ");
    let child = super::service::as_console_user(&line).map_err(|e| format!("msiexec: {e:#}"))?;
    child
        .wait(MSIEXEC)
        .ok_or_else(|| format!("msiexec did not end within {} min", MSIEXEC.as_secs() / 60))
}

/// msiexec, another install running waited out.
fn msi(op: Msi, file: &Path, found: &Found, log: &Path) -> Result<(), String> {
    let machine = found
        .install
        .as_ref()
        .is_some_and(|i| i.scope == ProviderInstallScope::Machine);
    if !machine && found.console.is_none() {
        return Err("no user session to run the installer in".into());
    }
    let args = msiexec_args(op, file, log, machine);
    let mut waits = MSI_BUSY_BACKOFF.iter();
    loop {
        match msi_exit(msiexec_once(&args, machine)?) {
            MsiExit::Done => return Ok(()),
            MsiExit::Busy => match waits.next() {
                Some(s) => std::thread::sleep(Duration::from_secs(*s)),
                None => return Err("another install kept running (1618)".into()),
            },
            MsiExit::Failed(e) => return Err(e),
        }
    }
}

/// The MSI installed or upgraded, in the scope the install already has (a
/// fresh one per-user, the MSI's default).
pub fn install(file: &Path, found: &Found, log: &Path, _downgrade: bool) -> Result<(), String> {
    msi(Msi::Install, file, found, log)
}

/// The installed version removed, by its own package: the MSI refuses to
/// install an older version over a newer one.
pub fn uninstall(file: &Path, found: &Found, log: &Path) -> Result<(), String> {
    msi(Msi::Uninstall, file, found, log)
}

pub fn start(found: &Found) -> Result<(), String> {
    let location = found
        .install
        .as_ref()
        .and_then(|i| i.location.clone())
        .ok_or("the install names no location")?;
    let exe = PathBuf::from(location).join("bin").join(SERVER_EXE);
    if !exe.is_file() {
        return Err(format!("no {}", exe.display()));
    }
    let line = format!(
        "{} --silent",
        crate::jobs::windows_quote(&exe.display().to_string())
    );
    super::service::as_console_user(&line)
        .map(drop)
        .map_err(|e| format!("starting it: {e:#}"))
}

/// `/internal/shutdown`: it unloads its models and exits. It may close the
/// connection before it answers; the caller waits for it to fall silent.
pub fn stop(_found: &Found, port: u16) -> Result<(), String> {
    if let Err(e) = crate::node::providers::shutdown(port) {
        tracing::info!(error = %e, "the shutdown call did not answer cleanly");
    }
    Ok(())
}

pub fn set_startup(found: &Found, on: bool) -> Result<(), String> {
    let (i, c) = match (&found.install, &found.console) {
        (Some(i), Some(c)) => (i, c),
        _ => return Err("no install, or no user session".into()),
    };
    let (_, root, sub) = startup_place(i, c).ok_or("no Startup folder for it")?;
    // SAFETY: a plain query.
    let now = unsafe { windows::Win32::System::SystemInformation::GetSystemTimeAsFileTime() };
    let value = startup_value(
        on,
        (u64::from(now.dwHighDateTime) << 32) | u64::from(now.dwLowDateTime),
    );
    let (s, v) = (wide(&sub), wide(SHORTCUT));
    // SAFETY: twelve bytes from a twelve-byte array; the strings are
    // NUL-terminated for the call.
    let rc = unsafe {
        RegSetKeyValueW(
            root,
            PCWSTR(s.as_ptr()),
            PCWSTR(v.as_ptr()),
            REG_BINARY.0,
            Some(value.as_ptr().cast()),
            value.len() as u32,
        )
    };
    if rc.is_err() {
        return Err(format!("writing its startup approval: {}", rc.0));
    }
    Ok(())
}
