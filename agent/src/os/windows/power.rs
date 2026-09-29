//! Keeping a Windows machine awake: a `SystemRequired` power request, and
//! the power plan's sleep and hibernate timers set to never through
//! `powercfg` (power.rs has the why).

use std::process::Command;

use anyhow::Result;
use windows::Win32::Foundation::HANDLE;

pub struct Hold {
    handle: HANDLE,
}

impl Hold {
    /// Take the power request. The reason is what `powercfg /requests` shows.
    pub fn acquire(reason: &str) -> Result<Self> {
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
}

impl Drop for Hold {
    fn drop(&mut self) {
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

/// Set the plan so the machine never sleeps or hibernates on its own, and
/// turn hibernation off. Idempotent and quiet: `powercfg` does not say
/// whether a value moved, so this reports only that every call succeeded.
pub fn converge_plan() -> Result<Option<&'static str>> {
    let steps: [&[&str]; 5] = [
        &["/change", "standby-timeout-ac", "0"],
        &["/change", "hibernate-timeout-ac", "0"],
        &["/change", "standby-timeout-dc", "0"],
        &["/change", "hibernate-timeout-dc", "0"],
        &["/hibernate", "off"],
    ];
    for args in steps {
        let mut cmd = Command::new("powercfg");
        cmd.args(args);
        match crate::exec::both(cmd, std::time::Duration::from_secs(30)) {
            Some(r) if r.ok => {}
            Some(r) => anyhow::bail!("powercfg {}: {}", args.join(" "), r.output.trim()),
            None => anyhow::bail!("powercfg {}: not run, or no answer in time", args.join(" ")),
        }
    }
    Ok(Some("idle sleep and hibernate timers off, hibernation off"))
}

/// `powercfg /requests`: what Windows says is holding it awake.
pub fn requests_report() -> Option<String> {
    let mut cmd = Command::new("powercfg");
    cmd.arg("/requests");
    crate::exec::stdout_any(
        cmd,
        std::time::Duration::from_secs(30),
        crate::exec::Text::Lossy,
    )
    .ok()
    .map(|(_, s)| s.trim().to_string())
}

pub fn os_uptime_secs() -> Option<u64> {
    use windows::Win32::System::SystemInformation::GetTickCount64;
    // SAFETY: no arguments, no state.
    Some(unsafe { GetTickCount64() } / 1000)
}
