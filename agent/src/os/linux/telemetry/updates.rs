//! What the OS has pending, hourly on its own thread: apt, dnf or pacman,
//! each asked from its local cache — never a network refresh, which is the
//! machine's own schedule to run — the recent installs from their logs, and
//! whether a reboot is waiting: Debian's flag file, `needs-restarting` on
//! Fedora, or on NixOS the booted generation's kernel against the current
//! one's.

use std::path::Path;
use std::time::Duration;

use super::super::read;
use super::{tool, tool_any};
use crate::telemetry::parse::linux_tools;
use crate::telemetry::Updates;

/// Reading a package cache: seconds, but a busy disk is not an error.
const QUERY: Duration = Duration::from_secs(120);
/// How many recent installs the page shows.
const RECENT: usize = 10;

fn is_nixos() -> bool {
    Path::new("/etc/NIXOS").exists()
}

pub fn read_updates() -> Updates {
    let mut u = Updates {
        checked_at: Some(crate::state::now_rfc3339()),
        ..Default::default()
    };
    if crate::exec::locate("apt").is_some() {
        match tool("apt", &["list", "--upgradable"], QUERY) {
            Ok(t) => u.pending = linux_tools::apt_upgradable(&t),
            Err(e) => u.error = Some(e),
        }
        u.installed = read("/var/log/dpkg.log")
            .map(|t| linux_tools::dpkg_log(&t, RECENT))
            .unwrap_or_default();
        u.reboot_pending = Some(Path::new("/var/run/reboot-required").exists());
    } else if crate::exec::locate("dnf").is_some() {
        match tool_any("dnf", &["-q", "--cacheonly", "check-update"], QUERY) {
            // 100: updates are listed; 0: none.
            Ok((0 | 100, t)) => u.pending = linux_tools::dnf_check_update(&t),
            Ok((code, _)) => u.error = Some(format!("dnf check-update: exit {code}")),
            Err(e) => u.error = Some(e),
        }
        if let Ok(t) = tool("rpm", &["-qa", "--last"], QUERY) {
            u.installed = linux_tools::rpm_last(&t, RECENT);
        }
        // `needs-restarting -r`: 1 when a reboot is needed, 0 when not.
        u.reboot_pending = match tool_any("needs-restarting", &["-r"], QUERY) {
            Ok((1, _)) => Some(true),
            Ok((0, _)) => Some(false),
            _ => None,
        };
    } else if crate::exec::locate("pacman").is_some() {
        match tool_any("pacman", &["-Qu"], QUERY) {
            // 1: nothing to upgrade.
            Ok((0 | 1, t)) => u.pending = linux_tools::pacman_qu(&t),
            Ok((code, _)) => u.error = Some(format!("pacman -Qu: exit {code}")),
            Err(e) => u.error = Some(e),
        }
        u.installed = read("/var/log/pacman.log")
            .map(|t| linux_tools::pacman_log(&t, RECENT))
            .unwrap_or_default();
    } else if is_nixos() {
        u.error = Some(
            "NixOS lists no pending packages: the system moves by generation (a new lock and nixos-rebuild)"
                .into(),
        );
    } else {
        u.error = Some("no apt, dnf or pacman on this machine".into());
    }
    if is_nixos() {
        u.reboot_pending = nixos_reboot_pending();
    }
    u
}

/// The booted generation's kernel, initrd and modules against the current
/// one's: a difference is a switch that only a reboot finishes.
fn nixos_reboot_pending() -> Option<bool> {
    let mut any = false;
    for part in ["kernel", "initrd", "kernel-modules"] {
        let booted = std::fs::read_link(format!("/run/booted-system/{part}")).ok()?;
        let current = std::fs::read_link(format!("/run/current-system/{part}")).ok()?;
        any |= booted != current;
    }
    Some(any)
}
