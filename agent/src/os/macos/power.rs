//! Keeping a Mac awake: an IOKit power assertion,
//! `PreventUserIdleSystemSleep` — the one `caffeinate -i` takes, listed by
//! `pmset -g assertions` (power.rs has the why). There is no second line
//! here: `pmset` changes are the user's to make.

use anyhow::{Context, Result};
use std::ffi::{c_char, c_void, CString};

pub struct Hold {
    id: u32,
}

impl Hold {
    /// Take the assertion. The reason is what `pmset -g assertions` shows.
    pub fn acquire(reason: &str) -> Result<Self> {
        let id = assert(reason)?;
        tracing::info!(
            reason,
            id,
            "power assertion held: PreventUserIdleSystemSleep"
        );
        Ok(Self { id })
    }
}

impl Drop for Hold {
    fn drop(&mut self) {
        release(self.id);
        tracing::info!("power assertion released");
    }
}

/// Nothing to converge: the assertion is the whole mechanism.
pub fn converge_plan() -> Result<Option<&'static str>> {
    Ok(None)
}

/// `pmset -g assertions`: what macOS says is holding it awake.
pub fn requests_report() -> Option<String> {
    let mut cmd = std::process::Command::new("pmset");
    cmd.args(["-g", "assertions"]);
    let (_, text) = crate::exec::stdout_any(
        cmd,
        std::time::Duration::from_secs(10),
        crate::exec::Text::Lossy,
    )
    .ok()?;
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

pub fn os_uptime_secs() -> Option<u64> {
    uptime_secs()
}

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
fn assert(reason: &str) -> Result<u32> {
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

fn release(id: u32) {
    // SAFETY: the id came from IOPMAssertionCreateWithName and is released once.
    unsafe {
        let _ = IOPMAssertionRelease(id);
    }
}

/// `kern.boottime` against the wall clock.
fn uptime_secs() -> Option<u64> {
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
