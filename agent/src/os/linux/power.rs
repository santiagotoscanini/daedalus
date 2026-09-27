//! Keeping a Linux machine awake: a logind inhibitor lock on `sleep:idle`
//! in block mode — what `systemd-inhibit --list` shows, with the reason
//! beside it (power.rs has the why). The lock lives as long as the
//! `systemd-inhibit … sleep infinity` child the `Hold` owns: dropping the
//! hold ends the child, and logind releases the lock with it. Should the
//! agent die without dropping it, the child is sent SIGTERM by the kernel
//! (`PR_SET_PDEATHSIG`), and under systemd the unit's cgroup is killed
//! whole anyway. A D-Bus client would take the same lock in-process; the
//! child costs no dependency and is the tool every distribution ships.
//! There is no second line: the machine's own sleep settings are its
//! owner's.
//!
//! What it costs, stated plainly: a block-mode `sleep` inhibitor also
//! refuses a suspend the user asks for (the menu's Suspend, `systemctl
//! suspend`) for as long as the box's policy says "keep awake" — unlike
//! Windows' and macOS's holds, which only stop the idle timer. `idle` alone
//! would not do: GNOME's idle suspend goes through logind's sleep, not its
//! idle lock. Turning the policy off on Settings › Machines releases the
//! lock at once, and suspend works again.

use std::io::Read;
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

use anyhow::{bail, Context, Result};

use crate::exec;

pub struct Hold {
    child: Child,
}

impl Hold {
    /// Take the lock. `reason` is what `systemd-inhibit --list` shows.
    pub fn acquire(reason: &str) -> Result<Self> {
        let inhibit = exec::locate("systemd-inhibit")
            .context("no systemd-inhibit on this machine (the awake hold needs systemd-logind)")?;
        let mut cmd = Command::new(inhibit);
        cmd.args([
            "--what=sleep:idle",
            "--mode=block",
            "--who=daedalus-agent",
            &format!("--why={reason}"),
            "sleep",
            "infinity",
        ])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
        super::super::unix::own_process_group(&mut cmd);
        // SAFETY: prctl in the forked child before exec, async-signal-safe.
        unsafe {
            use std::os::unix::process::CommandExt;
            cmd.pre_exec(|| {
                libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
                Ok(())
            });
        }
        let mut child = cmd.spawn().context("starting systemd-inhibit")?;
        // A refusal (logind absent, polkit saying no) ends it at once; a
        // lock taken leaves it waiting on `sleep`. Two seconds tells them
        // apart.
        let until = Instant::now() + Duration::from_secs(2);
        while Instant::now() < until {
            if let Some(status) = child.try_wait()? {
                let mut why = String::new();
                if let Some(mut e) = child.stderr.take() {
                    let _ = e.read_to_string(&mut why);
                }
                bail!(
                    "systemd-inhibit exited ({status}): {}",
                    why.lines()
                        .find(|l| !l.trim().is_empty())
                        .unwrap_or("no reason given")
                        .trim()
                );
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        tracing::info!(
            reason,
            pid = child.id(),
            "logind inhibitor held: sleep:idle, block"
        );
        Ok(Self { child })
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        super::super::unix::stop_process_tree(&mut self.child);
        let _ = self.child.kill();
        let _ = self.child.wait();
        tracing::info!("logind inhibitor released");
    }
}

/// Nothing to converge: the inhibitor is the whole mechanism.
pub fn converge_plan() -> Result<Option<&'static str>> {
    Ok(None)
}

/// `systemd-inhibit --list`: what logind says is holding it awake.
pub fn requests_report() -> Option<String> {
    let mut cmd = Command::new(exec::locate("systemd-inhibit")?);
    cmd.args(["--list", "--no-pager"]);
    let text = exec::stdout_or(cmd, Duration::from_secs(3), exec::Text::Lossy).ok()?;
    Some(
        text.lines()
            .take(60)
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
    )
}

/// `/proc/uptime`.
pub fn os_uptime_secs() -> Option<u64> {
    super::read("/proc/uptime").and_then(|t| crate::telemetry::parse::linux_sys::uptime_secs(&t))
}
