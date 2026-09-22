//! Keeping the machine awake.
//!
//! Two lines of defence, both taken at start:
//!
//! 1. A power request, held for the life of the process. On Windows that is
//!    `PowerCreateRequest` + `PowerSetRequest` with `PowerRequestSystemRequired`
//!    — what Windows itself uses and what `powercfg /requests` lists, with
//!    the reason string beside it. On macOS it is an IOKit power assertion
//!    (`PreventUserIdleSystemSleep`, the same one `caffeinate -i` takes),
//!    listed by `pmset -g assertions`. Either stops the idle timer from
//!    sleeping the machine. Neither stops a person choosing Sleep, closing a
//!    laptop's lid, or an OS update restart.
//! 2. On Windows, the active power plan's timeouts set to zero and
//!    hibernation turned off, through `powercfg`: if the service is ever
//!    stopped, the plan alone keeps the machine up. macOS has no second
//!    line here — `pmset` changes are the user's to make, and the assertion
//!    is what Apple's own tools use.
//!
//! On anything else this module compiles to a no-op that reports it did
//! nothing, so the rest of the agent can be run and tested elsewhere.

use anyhow::Result;

pub struct Hold {
    #[cfg(windows)]
    handle: windows::Win32::Foundation::HANDLE,
    #[cfg(target_os = "macos")]
    id: u32,
}

impl Hold {
    /// Take the power request. The reason is what `powercfg /requests` or
    /// `pmset -g assertions` shows.
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
        #[cfg(target_os = "macos")]
        {
            let id = mac::assert(reason)?;
            tracing::info!(
                reason,
                id,
                "power assertion held: PreventUserIdleSystemSleep"
            );
            Ok(Self { id })
        }
        #[cfg(not(any(windows, target_os = "macos")))]
        {
            let _ = reason;
            anyhow::bail!("power requests are Windows- and macOS-only in this version")
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
        #[cfg(target_os = "macos")]
        {
            mac::release(self.id);
            tracing::info!("power assertion released");
        }
    }
}

/// Set the plan so the machine never sleeps or hibernates on its own, and
/// turn hibernation off. Idempotent and quiet: `powercfg` does not say whether
/// a value moved, so this reports only that every call succeeded. A no-op
/// on macOS, where the assertion is the whole mechanism.
/// Returns what it did, or None where there is nothing to do.
pub fn converge_plan() -> Result<Option<&'static str>> {
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
        Ok(Some("idle sleep and hibernate timers off, hibernation off"))
    }
    #[cfg(not(windows))]
    {
        Ok(None)
    }
}

/// What the OS says is holding it awake right now — the proof, for the
/// status page, that the hold is visible to the OS and not just to this
/// process. `powercfg /requests` on Windows, `pmset -g assertions` on macOS.
pub fn requests_report() -> Option<String> {
    #[cfg(windows)]
    {
        let out = std::process::Command::new("powercfg")
            .arg("/requests")
            .output()
            .ok()?;
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    }
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("pmset")
            .args(["-g", "assertions"])
            .output()
            .ok()?;
        let text = String::from_utf8_lossy(&out.stdout);
        // The listing runs long on a busy machine; the summary and the
        // per-process lines are the part that names this agent.
        Some(
            text.lines()
                .take(60)
                .collect::<Vec<_>>()
                .join("\n")
                .trim()
                .to_string(),
        )
    }
    #[cfg(not(any(windows, target_os = "macos")))]
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
    #[cfg(target_os = "macos")]
    {
        mac::uptime_secs()
    }
    #[cfg(not(any(windows, target_os = "macos")))]
    {
        None
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use anyhow::{Context, Result};
    use std::ffi::{c_char, c_void, CString};

    type CFStringRef = *const c_void;
    type CFAllocatorRef = *const c_void;
    type IOReturn = i32;

    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;
    /// `kIOPMAssertionLevelOn`.
    const LEVEL_ON: u32 = 255;

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithCString(
            alloc: CFAllocatorRef,
            c_str: *const c_char,
            encoding: u32,
        ) -> CFStringRef;
        fn CFRelease(cf: *const c_void);
    }

    #[link(name = "IOKit", kind = "framework")]
    extern "C" {
        fn IOPMAssertionCreateWithName(
            assertion_type: CFStringRef,
            level: u32,
            name: CFStringRef,
            id: *mut u32,
        ) -> IOReturn;
        fn IOPMAssertionRelease(id: u32) -> IOReturn;
    }

    fn cf_string(s: &str) -> Result<CFStringRef> {
        let c = CString::new(s).context("string has a NUL")?;
        // SAFETY: a valid C string; the CFString copies it.
        let r = unsafe {
            CFStringCreateWithCString(std::ptr::null(), c.as_ptr(), K_CF_STRING_ENCODING_UTF8)
        };
        if r.is_null() {
            anyhow::bail!("CFString not created");
        }
        Ok(r)
    }

    /// Take a `PreventUserIdleSystemSleep` assertion named `reason`.
    pub fn assert(reason: &str) -> Result<u32> {
        let kind = cf_string("PreventUserIdleSystemSleep")?;
        let name = cf_string(reason)?;
        let mut id: u32 = 0;
        // SAFETY: both strings are live for the call and released after; the
        // id is written by IOKit on success.
        let rc = unsafe { IOPMAssertionCreateWithName(kind, LEVEL_ON, name, &mut id) };
        unsafe {
            CFRelease(kind);
            CFRelease(name);
        }
        if rc != 0 {
            anyhow::bail!("IOPMAssertionCreateWithName returned {rc:#x}");
        }
        Ok(id)
    }

    pub fn release(id: u32) {
        // SAFETY: the id came from IOPMAssertionCreateWithName and is released once.
        unsafe {
            let _ = IOPMAssertionRelease(id);
        }
    }

    /// `kern.boottime` against the wall clock.
    pub fn uptime_secs() -> Option<u64> {
        let mut tv = libc::timeval {
            tv_sec: 0,
            tv_usec: 0,
        };
        let mut len = std::mem::size_of::<libc::timeval>();
        let name = CString::new("kern.boottime").ok()?;
        // SAFETY: the buffer is a timeval and its length says so.
        let rc = unsafe {
            libc::sysctlbyname(
                name.as_ptr(),
                (&mut tv as *mut libc::timeval).cast(),
                &mut len,
                std::ptr::null_mut(),
                0,
            )
        };
        if rc != 0 || tv.tv_sec <= 0 {
            return None;
        }
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .ok()?
            .as_secs();
        Some(now.saturating_sub(tv.tv_sec as u64))
    }
}
