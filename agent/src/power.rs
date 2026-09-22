//! Keeping the machine awake.
//!
//! Two lines of defence, both taken at start:
//!
//! 1. A power request (`PowerCreateRequest` + `PowerSetRequest` with
//!    `PowerRequestSystemRequired`), held for the life of the process. This
//!    is what Windows itself uses and what `powercfg /requests` lists, with
//!    the reason string beside it, so an operator at the machine can see who
//!    is holding it and why. It stops the idle timer from sleeping or
//!    hibernating the machine. It does not stop a person choosing Sleep, and
//!    it does not stop a Windows Update restart.
//! 2. The active power plan's AC timeouts set to zero and hibernation turned
//!    off, through `powercfg`. Belt to the request's braces: if the service
//!    is ever stopped, the plan alone keeps the machine up.
//!
//! On anything but Windows this module compiles to a no-op that reports it
//! did nothing, so the rest of the agent can be run and tested elsewhere.

use anyhow::Result;

pub struct Hold {
    #[cfg(windows)]
    handle: windows::Win32::Foundation::HANDLE,
}

impl Hold {
    /// Take the power request. The reason is what `powercfg /requests` shows.
    pub fn acquire(reason: &str) -> Result<Self> {
        #[cfg(windows)]
        {
            use windows::core::PWSTR;
            use windows::Win32::System::Power::{
                PowerCreateRequest, PowerRequestSystemRequired, PowerSetRequest,
            };
            use windows::Win32::System::Threading::{
                POWER_REQUEST_CONTEXT_SIMPLE_STRING, REASON_CONTEXT, REASON_CONTEXT_0,
            };

            // POWER_REQUEST_CONTEXT_VERSION is DIAGNOSTIC_REASON_VERSION, which the
            // SDK defines as 0; the crate does not export the alias.
            const CONTEXT_VERSION: u32 = 0;

            let mut wide: Vec<u16> = reason.encode_utf16().chain(std::iter::once(0)).collect();
            let context = REASON_CONTEXT {
                Version: CONTEXT_VERSION,
                Flags: POWER_REQUEST_CONTEXT_SIMPLE_STRING,
                Reason: REASON_CONTEXT_0 {
                    SimpleReasonString: PWSTR(wide.as_mut_ptr()),
                },
            };
            // SAFETY: `context` and the string it points at outlive the two
            // calls; Windows copies the reason on create.
            let handle = unsafe { PowerCreateRequest(&context) }?;
            unsafe { PowerSetRequest(handle, PowerRequestSystemRequired) }?;
            tracing::info!(reason, "power request held: SystemRequired");
            Ok(Self { handle })
        }
        #[cfg(not(windows))]
        {
            let _ = reason;
            anyhow::bail!("power requests are Windows-only in this version")
        }
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        #[cfg(windows)]
        {
            use windows::Win32::Foundation::CloseHandle;
            use windows::Win32::System::Power::{PowerClearRequest, PowerRequestSystemRequired};
            // SAFETY: the handle came from PowerCreateRequest and is cleared once.
            unsafe {
                let _ = PowerClearRequest(self.handle, PowerRequestSystemRequired);
                let _ = CloseHandle(self.handle);
            }
            tracing::info!("power request released");
        }
    }
}

/// Set the plan so the machine never sleeps or hibernates on its own, and
/// turn hibernation off. Idempotent and quiet: `powercfg` does not say whether
/// a value moved, so this reports only that every call succeeded.
pub fn converge_plan() -> Result<()> {
    #[cfg(windows)]
    {
        use std::process::Command;
        let steps: [&[&str]; 5] = [
            &["/change", "standby-timeout-ac", "0"],
            &["/change", "hibernate-timeout-ac", "0"],
            &["/change", "standby-timeout-dc", "0"],
            &["/change", "hibernate-timeout-dc", "0"],
            &["/hibernate", "off"],
        ];
        for args in steps {
            let out = Command::new("powercfg").args(args).output()?;
            if !out.status.success() {
                anyhow::bail!(
                    "powercfg {}: {}",
                    args.join(" "),
                    String::from_utf8_lossy(&out.stderr).trim()
                );
            }
        }
        Ok(())
    }
    #[cfg(not(windows))]
    {
        Ok(())
    }
}

/// What `powercfg /requests` says right now — the proof, for the status
/// page, that the hold is visible to the OS and not just to this process.
pub fn requests_report() -> Option<String> {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("powercfg")
            .arg("/requests")
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
    #[cfg(not(windows))]
    {
        None
    }
}

/// Seconds since the machine booted, from the OS — distinct from the
/// agent's own uptime, and the number that shows a scheduled restart.
pub fn os_uptime_secs() -> Option<u64> {
    #[cfg(windows)]
    {
        use windows::Win32::System::SystemInformation::GetTickCount64;
        // SAFETY: no arguments, no state.
        Some(unsafe { GetTickCount64() } / 1000)
    }
    #[cfg(not(windows))]
    {
        None
    }
}
