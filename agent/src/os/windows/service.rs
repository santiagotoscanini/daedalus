//! The Windows service around `agent_main`: what the Service Control
//! Manager starts at boot, and the two verbs that register and remove it —
//! Windows' side of `os::svc`.
//!
//! Runs as LocalSystem: the power request has to outlive any user session,
//! and the binary swap writes under Program Files. Recovery actions restart
//! the service on any failure, including a non-zero exit — which is how an
//! update is applied: the updater swaps the binary and exits 3.

use crate::util::Shutdown;
use std::ffi::OsString;
use std::time::Duration;

use anyhow::{bail, Context, Result};
use windows_service::service::{
    ServiceAccess, ServiceAction, ServiceActionType, ServiceControl, ServiceErrorControl,
    ServiceExitCode, ServiceFailureActions, ServiceFailureResetPeriod, ServiceInfo,
    ServiceStartType, ServiceState, ServiceStatus, ServiceType,
};
use windows_service::service_control_handler::{self, ServiceControlHandlerResult};
use windows_service::service_manager::{ServiceManager, ServiceManagerAccess};
use windows_service::{define_windows_service, service_dispatcher};

use crate::config::{self, Config};
use crate::paths;
use crate::{DISPLAY_NAME, SERVICE_NAME, TRAY_EXE};

define_windows_service!(ffi_service_main, service_main);

/// `daedalus-agent run`: hand the process to the dispatcher. Returns when
/// the service has stopped.
pub fn run_service() -> Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .context("the Service Control Manager did not accept this process — `run` is for the SCM; use `serve` in a terminal")?;
    Ok(())
}

fn service_main(_args: Vec<OsString>) {
    // Errors have nowhere to go but the log, which agent_main opens; before
    // that, the SCM's own event ("service terminated") is the record.
    let _ = serve_under_scm();
}

fn serve_under_scm() -> Result<()> {
    let stop = Shutdown::new();
    let handler = {
        let stop = stop.clone();
        move |control: ServiceControl| match control {
            ServiceControl::Stop | ServiceControl::Shutdown | ServiceControl::Preshutdown => {
                stop.stop();
                ServiceControlHandlerResult::NoError
            }
            ServiceControl::Interrogate => ServiceControlHandlerResult::NoError,
            _ => ServiceControlHandlerResult::NotImplemented,
        }
    };
    let status = service_control_handler::register(SERVICE_NAME, handler)?;

    let report = |state: ServiceState, code: u32| {
        let _ = status.set_service_status(ServiceStatus {
            service_type: ServiceType::OWN_PROCESS,
            current_state: state,
            controls_accepted: if state == ServiceState::Running {
                windows_service::service::ServiceControlAccept::STOP
                    | windows_service::service::ServiceControlAccept::SHUTDOWN
                    | windows_service::service::ServiceControlAccept::PRESHUTDOWN
            } else {
                windows_service::service::ServiceControlAccept::empty()
            },
            exit_code: ServiceExitCode::Win32(code),
            checkpoint: 0,
            wait_hint: Duration::from_secs(10),
            process_id: None,
        });
    };

    report(ServiceState::Running, 0);
    let outcome = crate::service::agent_main(stop, false);
    report(ServiceState::Stopped, if outcome.is_ok() { 0 } else { 1 });
    outcome
}

/// Where the service runs from: `%ProgramFiles%\daedalus-agent`, where
/// install.ps1 puts it.
fn install_dir() -> std::path::PathBuf {
    std::env::var_os("ProgramFiles")
        .map(std::path::PathBuf::from)
        .unwrap_or_else(|| r"C:\Program Files".into())
        .join("daedalus-agent")
}

/// This binary, as the service is registered at: refused unless it runs
/// from `install_dir`, and that directory, it and the tray beside it are
/// owned by SYSTEM, Administrators or TrustedInstaller and writable by
/// nobody else — LocalSystem runs whatever is there, at every boot.
fn installed_exe() -> Result<std::path::PathBuf> {
    let exe = std::env::current_exe().context("locating this binary")?;
    let dir = install_dir();
    let here = std::fs::canonicalize(&exe).context("locating this binary")?;
    let canonical = std::fs::canonicalize(&dir).ok();
    if canonical.is_none() || here.parent() != canonical.as_deref() {
        bail!(
            "install registers the service from {}: run install.ps1, which puts it there, \
             not {}",
            dir.display(),
            exe.display()
        );
    }
    let exe = dir.join(here.file_name().context("this binary has no name")?);
    super::acl::check_admins_alone_write(&dir)?;
    super::acl::check_admins_alone_write(&exe)?;
    let tray = dir.join(TRAY_EXE);
    if tray.exists() {
        super::acl::check_admins_alone_write(&tray)?;
    }
    Ok(exe)
}

/// `daedalus-agent install`: the service, its recovery, the config file, and
/// a start. Idempotent: a second run on an installed
/// machine updates the binary path (the installer copies a new exe to the
/// same place), leaves config.toml alone, and makes sure the service runs.
pub fn install(cfg: &Config) -> Result<()> {
    let exe = installed_exe()?;
    let manager = ServiceManager::local_computer(
        None::<&str>,
        ServiceManagerAccess::CONNECT | ServiceManagerAccess::CREATE_SERVICE,
    )
    .context("opening the Service Control Manager — run this from an administrator shell")?;

    let info = ServiceInfo {
        name: OsString::from(SERVICE_NAME),
        display_name: OsString::from(DISPLAY_NAME),
        service_type: ServiceType::OWN_PROCESS,
        start_type: ServiceStartType::AutoStart,
        error_control: ServiceErrorControl::Normal,
        executable_path: exe.clone(),
        launch_arguments: vec![OsString::from("run")],
        dependencies: vec![],
        account_name: None, // LocalSystem
        account_password: None,
    };
    let access = ServiceAccess::QUERY_STATUS
        | ServiceAccess::START
        | ServiceAccess::STOP
        | ServiceAccess::CHANGE_CONFIG;

    let service = match manager.open_service(SERVICE_NAME, access) {
        Ok(existing) => {
            existing
                .change_config(&info)
                .context("updating the service's configuration")?;
            println!("service {SERVICE_NAME} already registered; configuration refreshed");
            existing
        }
        Err(_) => {
            let s = manager
                .create_service(&info, access)
                .context("creating the service")?;
            println!("service {SERVICE_NAME} registered as {}", exe.display());
            s
        }
    };
    service
        .set_description("Keeps this machine awake for the daedalus controller, reports to it over one connection, and updates itself from the engine's releases.")
        .context("setting the description")?;

    // Restart on any exit that is not a clean stop — including the exit
    // the updater makes on purpose. Three tries (after 3 s, 10 s, 60 s); the
    // failure count resets after a day.
    service
        .update_failure_actions(ServiceFailureActions {
            reset_period: ServiceFailureResetPeriod::After(Duration::from_secs(86_400)),
            reboot_msg: None,
            command: None,
            actions: Some(vec![
                ServiceAction {
                    action_type: ServiceActionType::Restart,
                    delay: Duration::from_secs(3),
                },
                ServiceAction {
                    action_type: ServiceActionType::Restart,
                    delay: Duration::from_secs(10),
                },
                ServiceAction {
                    action_type: ServiceActionType::Restart,
                    delay: Duration::from_secs(60),
                },
            ]),
        })
        .context("setting recovery actions")?;
    service
        .set_failure_actions_on_non_crash_failures(true)
        .context("counting non-zero exits as failures")?;

    let path = config::write_for_install(cfg)?;
    println!("config at {}", path.display());

    // SYSTEM and Administrators own the data; Users read it (private.rs).
    let mut dirs = vec![paths::config_dir()];
    if !dirs.contains(&paths::data_dir()) {
        dirs.push(paths::data_dir());
    }
    for dir in dirs {
        super::protect_data_dir(&dir)
            .with_context(|| format!("setting the DACL of {}", dir.display()))?;
        println!(
            "{}: SYSTEM and Administrators full control, Users read",
            dir.display()
        );
    }

    let state = service
        .query_status()
        .context("querying the service")?
        .current_state;
    if state == ServiceState::Running {
        println!("service already running; stop and start it to pick up a new binary");
    } else {
        service.start::<&str>(&[]).context("starting the service")?;
        println!("service started");
    }

    let tray = exe.with_file_name(TRAY_EXE);
    if tray.exists() {
        tray_register(&tray)?;
        tray_start(&tray);
        println!("tray registered for every logon and started");
    } else {
        println!("no {TRAY_EXE} beside the service; the tray is not registered");
    }
    println!("status: daedalus-agent status");
    Ok(())
}

/// `daedalus-agent uninstall`: stop, delete, drop the tray's Run key (and
/// the running tray). The data directory (config,
/// state, identity, logs) is left for the operator.
pub fn uninstall() -> Result<()> {
    let manager = ServiceManager::local_computer(None::<&str>, ServiceManagerAccess::CONNECT)
        .context("opening the Service Control Manager — run this from an administrator shell")?;
    let service = match manager.open_service(
        SERVICE_NAME,
        ServiceAccess::QUERY_STATUS | ServiceAccess::STOP | ServiceAccess::DELETE,
    ) {
        Ok(s) => s,
        Err(_) => {
            println!("service {SERVICE_NAME} is not registered");
            return Ok(());
        }
    };
    if service.query_status()?.current_state != ServiceState::Stopped {
        let _ = service.stop();
        for _ in 0..40 {
            if service.query_status()?.current_state == ServiceState::Stopped {
                break;
            }
            std::thread::sleep(Duration::from_millis(250));
        }
    }
    service.delete().context("deleting the service")?;
    println!("service {SERVICE_NAME} removed");
    tray_unregister();
    // Claude runs detached from the tray (jobs.rs), so it outlives both: its
    // Remote Control and the sessions' holders are ended by their records.
    super::jobs::stop_every_users_jobs();
    println!("data left in {}", paths::data_dir().display());
    Ok(())
}

// ── the tray ───────────────────────────────────────────────────────────────
//
// Registered for every user under HKLM's Run key, so it appears at each
// logon; started right away through Explorer, which launches it as the
// desktop's user rather than as the administrator running `install`.

const RUN_KEY: &str = r"HKLM\Software\Microsoft\Windows\CurrentVersion\Run";
const RUN_VALUE: &str = "daedalus-agent-tray";

/// One of Windows' own tools (`system_tool`), with a deadline (exec.rs).
fn system_command(tool: &str, args: &[&str]) -> Result<String> {
    let path = super::system_tool(tool)
        .with_context(|| format!("no system directory to run {tool} from"))?;
    let mut cmd = std::process::Command::new(path);
    cmd.args(args);
    crate::exec::stdout_or(cmd, Duration::from_secs(30), crate::exec::Text::Lossy)
        .map_err(|e| anyhow::anyhow!("{tool} {}: {e}", args.join(" ")))
}

fn tray_register(tray: &std::path::Path) -> Result<()> {
    let value = format!("\"{}\"", tray.display());
    system_command(
        "reg.exe",
        &[
            "add", RUN_KEY, "/v", RUN_VALUE, "/t", "REG_SZ", "/d", &value, "/f",
        ],
    )
    .map(drop)
}

/// Every tray ended, whoever runs it.
fn kill_trays() {
    let _ = system_command("taskkill.exe", &["/IM", TRAY_EXE, "/F"]);
}

fn tray_unregister() {
    let _ = system_command("reg.exe", &["delete", RUN_KEY, "/v", RUN_VALUE, "/f"]);
    kill_trays();
}

fn tray_start(tray: &std::path::Path) {
    // Explorer starts what it is handed at the desktop's integrity level,
    // which is how an elevated installer launches an unelevated tray.
    let _ = std::process::Command::new("explorer.exe").arg(tray).spawn();
}

// ── starting the tray from the service ────────────────────────────────────
//
// The Run key starts the tray at logon and nothing else does: a tray that
// dies (an update's relaunch that lost a race, a crash) leaves the machine
// with no menu and no Claude server until the next login. The service can
// put it back: it runs as LocalSystem, which may take the console user's
// token and start a process in that session on the interactive desktop.
// This is what the service starts when the tray has not reported for a while
// (service/watchdog.rs) — `WATCHES_TRAY` below is what
// turns that watchdog on; on macOS launchd's KeepAlive and
// `launchd::kickstart_tray` (os/macos/launchd.rs) do the same.

/// Someone is logged on at the console: a tray should be reporting
/// (update/, probation).
pub fn interactive_user() -> bool {
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
    // SAFETY: the token, when one is taken, is closed.
    unsafe {
        let session = WTSGetActiveConsoleSessionId();
        if session == 0xFFFF_FFFF {
            return false;
        }
        let mut token = HANDLE::default();
        if WTSQueryUserToken(session, &mut token).is_err() {
            return false;
        }
        let _ = CloseHandle(token);
        true
    }
}

/// After an update: every tray ended and the console user's started again
/// on the new binary (Claude runs on in its detached jobs). A tray in
/// another session comes back at its user's next logon.
pub fn restart_desktop_side() {
    kill_trays();
    std::thread::sleep(Duration::from_secs(1));
    match launch_tray_or_session() {
        Ok(()) => tracing::info!("tray restarted on the new version"),
        Err(e) => tracing::info!(error = format!("{e:#}"), "tray not restarted"),
    }
}
/// The service restarts a tray that stopped reporting.
pub const WATCHES_TRAY: bool = true;

/// Start the tray as the user at the console, in their session, with their
/// environment. Err when nobody is logged on, or the token is refused.
pub fn launch_tray_or_session() -> Result<()> {
    use std::ffi::c_void;
    use windows::core::{PCWSTR, PWSTR};
    use windows::Win32::Foundation::{CloseHandle, HANDLE};
    use windows::Win32::System::Environment::{CreateEnvironmentBlock, DestroyEnvironmentBlock};
    use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};
    use windows::Win32::System::Threading::{
        CreateProcessAsUserW, CREATE_UNICODE_ENVIRONMENT, PROCESS_INFORMATION, STARTUPINFOW,
    };

    let exe = std::env::current_exe().context("locating this binary")?;
    let tray = exe.with_file_name(TRAY_EXE);
    if !tray.exists() {
        bail!("no {TRAY_EXE} beside the service");
    }
    // SAFETY: Win32 calls in the documented order; every handle and block
    // taken is released before returning.
    unsafe {
        let session = WTSGetActiveConsoleSessionId();
        if session == 0xFFFF_FFFF {
            bail!("no console session");
        }
        let mut token = HANDLE::default();
        WTSQueryUserToken(session, &mut token).context("taking the console user's token")?;
        let mut env: *mut c_void = std::ptr::null_mut();
        let env_ok = CreateEnvironmentBlock(&mut env, Some(token), false).is_ok();
        let mut cmd: Vec<u16> = format!("\"{}\"", tray.display())
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let mut desktop: Vec<u16> = "winsta0\\default"
            .encode_utf16()
            .chain(std::iter::once(0))
            .collect();
        let si = STARTUPINFOW {
            cb: std::mem::size_of::<STARTUPINFOW>() as u32,
            lpDesktop: PWSTR(desktop.as_mut_ptr()),
            ..Default::default()
        };
        let mut pi = PROCESS_INFORMATION::default();
        let r = CreateProcessAsUserW(
            Some(token),
            PCWSTR::null(),
            Some(PWSTR(cmd.as_mut_ptr())),
            None,
            None,
            false,
            CREATE_UNICODE_ENVIRONMENT,
            if env_ok {
                Some(env as *const c_void)
            } else {
                None
            },
            PCWSTR::null(),
            &si,
            &mut pi,
        );
        if env_ok {
            let _ = DestroyEnvironmentBlock(env);
        }
        let _ = CloseHandle(token);
        match r {
            Ok(()) => {
                let _ = CloseHandle(pi.hThread);
                let _ = CloseHandle(pi.hProcess);
                tracing::info!(
                    session,
                    pid = pi.dwProcessId,
                    "tray started in the console session"
                );
                Ok(())
            }
            Err(e) => Err(e).context("starting the tray as the console user"),
        }
    }
}
