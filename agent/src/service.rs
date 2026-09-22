//! The Windows service around `agent_main`: what the Service Control
//! Manager starts at boot, and the two verbs that register and remove it.
//!
//! Runs as LocalSystem: the power request has to outlive any user session,
//! and the binary swap writes under Program Files. Recovery actions restart
//! the service on any failure, including a non-zero exit — which is how an
//! update is applied: the updater swaps the binary and exits 3.

use std::ffi::OsString;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
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
use crate::{DISPLAY_NAME, SERVICE_NAME};

define_windows_service!(ffi_service_main, service_main);

/// `daedalus-agent run`: hand the process to the dispatcher. Returns when
/// the service has stopped.
pub fn run() -> Result<()> {
    service_dispatcher::start(SERVICE_NAME, ffi_service_main)
        .context("the Service Control Manager did not accept this process — `run` is for the SCM; use `serve` in a terminal")?;
    Ok(())
}

fn service_main(_args: Vec<OsString>) {
    // Errors have nowhere to go but the log, which agent_main opens; before
    // that, the SCM's own event ("service terminated") is the record.
    let _ = run_service();
}

fn run_service() -> Result<()> {
    let stop = Arc::new(AtomicBool::new(false));
    let handler = {
        let stop = Arc::clone(&stop);
        move |control: ServiceControl| match control {
            ServiceControl::Stop | ServiceControl::Shutdown | ServiceControl::Preshutdown => {
                stop.store(true, Ordering::Relaxed);
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
    let outcome = crate::agent_main(stop, false);
    report(ServiceState::Stopped, if outcome.is_ok() { 0 } else { 1 });
    outcome
}

/// `daedalus-agent install`: the service, its recovery, the firewall rule,
/// the config file, and a start. Idempotent: a second run on an installed
/// machine updates the binary path (the installer copies a new exe to the
/// same place), leaves config.toml alone, and makes sure the service runs.
pub fn install(cfg: &Config) -> Result<()> {
    let exe = std::env::current_exe().context("locating this binary")?;
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
        .set_description("Keeps this machine awake for the daedalus control plane, answers a status page on the LAN, and updates itself from the engine's releases.")
        .context("setting the description")?;

    // Restart on any exit that is not a clean stop — including the exit
    // the updater makes on purpose. Three tries a few seconds apart, reset
    // after a day.
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

    let path = config::write_if_absent(cfg)?;
    println!("config at {}", path.display());

    firewall_allow(cfg.port)?;
    println!("firewall: TCP {} allowed from the local subnet", cfg.port);

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
    println!("status page: http://<this machine>:{}/status", cfg.port);
    Ok(())
}

/// `daedalus-agent uninstall`: stop, delete, drop the firewall rule. The
/// data directory (config, state, logs) is left for the operator.
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
            firewall_remove()?;
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
    firewall_remove()?;
    println!("data left in {}", config::data_dir().display());
    Ok(())
}

const FIREWALL_RULE: &str = "daedalus-agent status page";

fn firewall_allow(port: u16) -> Result<()> {
    firewall_remove()?;
    let out = std::process::Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "add",
            "rule",
            &format!("name={FIREWALL_RULE}"),
            "dir=in",
            "action=allow",
            "protocol=TCP",
            &format!("localport={port}"),
            "remoteip=LocalSubnet",
            "profile=any",
        ])
        .output()
        .context("running netsh")?;
    if !out.status.success() {
        bail!(
            "netsh add rule: {}",
            String::from_utf8_lossy(&out.stdout).trim()
        );
    }
    Ok(())
}

fn firewall_remove() -> Result<()> {
    // "No rules match" is a non-zero exit and fine.
    let _ = std::process::Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "delete",
            "rule",
            &format!("name={FIREWALL_RULE}"),
        ])
        .output()
        .context("running netsh")?;
    Ok(())
}
