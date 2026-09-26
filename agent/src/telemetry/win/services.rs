//! The Automatic services that are down: `EnumServicesStatusEx` for every
//! Win32 service, `QueryServiceConfig` on each stopped one to learn
//! whether it was meant to be running.

use windows::core::PCWSTR;
use windows::Win32::Foundation::{
    ERROR_SERVICE_NEVER_STARTED, ERROR_SERVICE_SPECIFIC_ERROR, ERROR_SUCCESS,
};
use windows::Win32::System::Services::{
    CloseServiceHandle, EnumServicesStatusExW, OpenSCManagerW, OpenServiceW, QueryServiceConfigW,
    ENUM_SERVICE_STATUS_PROCESSW, QUERY_SERVICE_CONFIGW, SC_ENUM_PROCESS_INFO, SC_HANDLE,
    SC_MANAGER_ENUMERATE_SERVICE, SERVICE_AUTO_START, SERVICE_CONTINUE_PENDING, SERVICE_PAUSED,
    SERVICE_PAUSE_PENDING, SERVICE_QUERY_CONFIG, SERVICE_RUNNING, SERVICE_START_PENDING,
    SERVICE_STATE_ALL, SERVICE_STATUS_CURRENT_STATE, SERVICE_STOPPED, SERVICE_STOP_PENDING,
    SERVICE_WIN32,
};

use super::meaningful;
use crate::telemetry::Service;

/// A service's state as the page says it.
fn service_state(s: SERVICE_STATUS_CURRENT_STATE) -> &'static str {
    match s {
        SERVICE_STOPPED => "stopped",
        SERVICE_START_PENDING => "start pending",
        SERVICE_STOP_PENDING => "stop pending",
        SERVICE_RUNNING => "running",
        SERVICE_CONTINUE_PENDING => "continue pending",
        SERVICE_PAUSE_PENDING => "pause pending",
        SERVICE_PAUSED => "paused",
        _ => "unknown",
    }
}

/// The exit code a stopped service reports: the service-specific one when
/// the Win32 code says to look there.
fn service_exit_code(win32: u32, specific: u32) -> u32 {
    if win32 == ERROR_SERVICE_SPECIFIC_ERROR.0 {
        specific
    } else {
        win32
    }
}

/// Whether a stopped Automatic service is worth listing: an exit code
/// other than success or "never started" (a trigger-start service that
/// has had no trigger yet).
fn service_is_down(exit: u32) -> bool {
    exit != ERROR_SUCCESS.0 && exit != ERROR_SERVICE_NEVER_STARTED.0
}

/// A service-control handle closed on drop, whatever path returns.
struct ScHandle(SC_HANDLE);

impl Drop for ScHandle {
    fn drop(&mut self) {
        // SAFETY: the handle was opened by the caller and is closed once.
        unsafe {
            let _ = CloseServiceHandle(self.0);
        }
    }
}

/// Whether a service is configured to start automatically (delayed or
/// not: both are `SERVICE_AUTO_START`). None when the config is refused.
fn service_is_automatic(scm: SC_HANDLE, name: PCWSTR) -> Option<bool> {
    // SAFETY: the manager handle is open; the name is a NUL-terminated
    // string inside the enumeration buffer, which outlives this call.
    let h = ScHandle(unsafe { OpenServiceW(scm, name, SERVICE_QUERY_CONFIG) }.ok()?);
    let mut needed: u32 = 0;
    // SAFETY: a size query with no buffer.
    let _ = unsafe { QueryServiceConfigW(h.0, None, 0, &mut needed) };
    if needed == 0 {
        return None;
    }
    // u64-backed so the struct's pointers are aligned; the strings it
    // points at follow it in the same buffer.
    let mut buf = vec![0u64; (needed as usize).div_ceil(8).max(1)];
    let size = u32::try_from(buf.len() * 8).ok()?;
    // SAFETY: the buffer is at least the size the call asked for and is
    // read as the struct at its start only after the call filled it.
    let start = unsafe {
        QueryServiceConfigW(
            h.0,
            Some(buf.as_mut_ptr().cast::<QUERY_SERVICE_CONFIGW>()),
            size,
            &mut needed,
        )
        .ok()?;
        (*buf.as_ptr().cast::<QUERY_SERVICE_CONFIGW>()).dwStartType
    };
    Some(start == SERVICE_AUTO_START)
}

/// Every Win32 service's status, and which Automatic ones are down.
pub(super) fn read_services() -> Result<(Vec<Service>, u32), String> {
    // SAFETY: the local manager, for enumeration only; the handle is
    // closed by `ScHandle`.
    let scm = ScHandle(
        unsafe { OpenSCManagerW(PCWSTR::null(), PCWSTR::null(), SC_MANAGER_ENUMERATE_SERVICE) }
            .map_err(|e| format!("OpenSCManager failed: {e}"))?,
    );
    let mut needed: u32 = 0;
    let mut count: u32 = 0;
    let mut resume: u32 = 0;
    // SAFETY: a size query with no buffer; it fails with the size needed.
    let _ = unsafe {
        EnumServicesStatusExW(
            scm.0,
            SC_ENUM_PROCESS_INFO,
            SERVICE_WIN32,
            SERVICE_STATE_ALL,
            None,
            &mut needed,
            &mut count,
            Some(&mut resume),
            PCWSTR::null(),
        )
    };
    if needed == 0 {
        return Err("EnumServicesStatusEx gave no size".into());
    }
    // Room for the services plus a few installed between the two calls;
    // u64-backed so the entries (pointers) are aligned.
    let mut buf = vec![0u64; (needed as usize + 4096).div_ceil(8)];
    resume = 0;
    // SAFETY: the buffer is passed with its length; the entries are read as
    // a slice of `count` structs at its start, and each name pointer points
    // into the same buffer, which outlives every read.
    let (services, total) = unsafe {
        let bytes = std::slice::from_raw_parts_mut(buf.as_mut_ptr().cast::<u8>(), buf.len() * 8);
        EnumServicesStatusExW(
            scm.0,
            SC_ENUM_PROCESS_INFO,
            SERVICE_WIN32,
            SERVICE_STATE_ALL,
            Some(bytes),
            &mut needed,
            &mut count,
            Some(&mut resume),
            PCWSTR::null(),
        )
        .map_err(|e| format!("EnumServicesStatusEx failed: {e}"))?;
        let entries = std::slice::from_raw_parts(
            buf.as_ptr().cast::<ENUM_SERVICE_STATUS_PROCESSW>(),
            count as usize,
        );
        let mut down = Vec::new();
        for e in entries {
            let st = &e.ServiceStatusProcess;
            if st.dwCurrentState == SERVICE_RUNNING || e.lpServiceName.is_null() {
                continue;
            }
            let exit = service_exit_code(st.dwWin32ExitCode, st.dwServiceSpecificExitCode);
            if !service_is_down(exit) {
                continue;
            }
            let name_ptr = PCWSTR(e.lpServiceName.as_ptr());
            if service_is_automatic(scm.0, name_ptr) != Some(true) {
                continue;
            }
            let name = String::from_utf16_lossy(e.lpServiceName.as_wide())
                .trim()
                .to_string();
            let display = (!e.lpDisplayName.is_null())
                .then(|| String::from_utf16_lossy(e.lpDisplayName.as_wide()))
                .and_then(|d| meaningful(&d))
                .filter(|d| d != &name);
            down.push(Service {
                name,
                display,
                state: service_state(st.dwCurrentState).to_string(),
                exit_code: Some(i64::from(exit)),
            });
        }
        (down, count)
    };
    Ok((services, total))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn service_filters() {
        assert_eq!(service_state(SERVICE_STOPPED), "stopped");
        assert_eq!(service_state(SERVICE_START_PENDING), "start pending");
        assert_eq!(service_exit_code(1066, 42), 42);
        assert_eq!(service_exit_code(5, 42), 5);
        assert!(!service_is_down(0));
        assert!(!service_is_down(1077));
        assert!(service_is_down(1053));
    }
}
