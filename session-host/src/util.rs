//! Small helpers every module shares.

use std::sync::{Mutex, MutexGuard};

use santree_remote_proto::{ErrorCode, WireError};

/// A mutex's guard, taken back from a holder that panicked rather than
/// passing the panic on.
pub fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|e| e.into_inner())
}

pub fn err(code: ErrorCode, msg: impl Into<String>) -> WireError {
    WireError::new(code, msg)
}

/// An I/O error as a wire error: `not_found` for a missing path, `io` for
/// everything else, its message prefixed with `what`.
pub fn io_err(e: std::io::Error, what: &str) -> WireError {
    let code = match e.kind() {
        std::io::ErrorKind::NotFound => ErrorCode::NotFound,
        _ => ErrorCode::Io,
    };
    err(code, format!("{what}: {e}"))
}
