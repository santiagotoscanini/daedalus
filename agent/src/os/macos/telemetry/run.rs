//! Running Apple's tools through the shared bounded shell-out (exec.rs): a
//! closed stdin, a deadline after which the command is killed, and stdout
//! as text; `plutil` for any plist, binary or XML. Beside them the few
//! facts read straight from the kernel: an integer sysctl, the CPU ticks
//! and the load averages.

use std::ffi::CString;
use std::process::Command;
use std::time::Duration;

use super::QUICK;
pub(super) use crate::exec::Failed;
use crate::exec::{stdout_or, Text};

/// A command's whole stdout, or why not; killed at the deadline. Text is
/// read strictly: a tool's output that is not UTF-8 reads as empty.
pub(super) fn output_or(cmd: Command, deadline: Duration) -> Result<String, Failed> {
    stdout_or(cmd, deadline, Text::Strict)
}

/// `output_or` without the reason: `None` when the command fails or is
/// still running at the deadline.
pub(super) fn output(cmd: Command, deadline: Duration) -> Option<String> {
    output_or(cmd, deadline).ok()
}

pub(super) fn run_for(cmd: &str, args: &[&str], deadline: Duration) -> Option<String> {
    let mut c = Command::new(cmd);
    c.args(args);
    output(c, deadline)
}

/// A quick command's stdout.
pub(super) fn run(cmd: &str, args: &[&str]) -> Option<String> {
    run_for(cmd, args, QUICK)
}

/// A quick command's stdout, trimmed; `None` when empty.
pub(super) fn line(cmd: &str, args: &[&str]) -> Option<String> {
    run(cmd, args)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
}

/// An integer sysctl, whatever its width (`hw.physicalcpu` is 32-bit,
/// `hw.memsize` 64-bit).
pub(super) fn sysctl_u64(name: &str) -> Option<u64> {
    let cname = CString::new(name).ok()?;
    let mut buf = [0u8; 8];
    let mut len = buf.len();
    // SAFETY: the buffer is eight bytes and `len` says so; the kernel writes
    // at most that many and reports how many.
    let rc = unsafe {
        libc::sysctlbyname(
            cname.as_ptr(),
            buf.as_mut_ptr().cast(),
            &mut len,
            std::ptr::null_mut(),
            0,
        )
    };
    if rc != 0 {
        return None;
    }
    match len {
        4 => Some(u64::from(u32::from_ne_bytes([
            buf[0], buf[1], buf[2], buf[3],
        ]))),
        8 => Some(u64::from_ne_bytes(buf)),
        _ => None,
    }
}

/// `hw.optional.arm64` is 1 on Apple Silicon, even under Rosetta.
pub(super) fn is_apple_silicon() -> bool {
    sysctl_u64("hw.optional.arm64") == Some(1)
}

extern "C" {
    /// libc's own binding is deprecated in favour of the `mach2` crate, which
    /// this crate does not carry; the symbol is libSystem's.
    fn mach_host_self() -> libc::mach_port_t;
}

/// `host_statistics64` CPU ticks: user, system, idle, nice.
pub(super) fn cpu_ticks() -> Option<[u32; 4]> {
    let mut info = libc::host_cpu_load_info { cpu_ticks: [0; 4] };
    let mut count = libc::HOST_CPU_LOAD_INFO_COUNT;
    // SAFETY: the out-buffer is a host_cpu_load_info and `count` is its size
    // in integers, as the call requires; the host port needs no release.
    let rc = unsafe {
        libc::host_statistics64(
            mach_host_self(),
            libc::HOST_CPU_LOAD_INFO,
            (&mut info as *mut libc::host_cpu_load_info).cast(),
            &mut count,
        )
    };
    if rc != libc::KERN_SUCCESS {
        return None;
    }
    let t = info.cpu_ticks;
    Some([
        t[libc::CPU_STATE_USER as usize],
        t[libc::CPU_STATE_SYSTEM as usize],
        t[libc::CPU_STATE_IDLE as usize],
        t[libc::CPU_STATE_NICE as usize],
    ])
}

pub(super) fn load_avg() -> Option<[f64; 3]> {
    let mut l = [0f64; 3];
    // SAFETY: three doubles, and the call is told there are three.
    let n = unsafe { libc::getloadavg(l.as_mut_ptr(), 3) };
    (n == 3).then_some(l)
}

/// A plist as XML, whatever it is on disk: `plutil -convert xml1 -o -`
/// reads binary and XML alike (and `-o -` leaves the file alone); when that
/// fails the file itself is read, which serves an XML one.
pub(super) fn plist_xml(path: &str, deadline: Duration) -> Result<String, Failed> {
    let mut plutil = Command::new("plutil");
    plutil.args(["-convert", "xml1", "-o", "-", path]);
    output_or(plutil, deadline)
        .or_else(|_| std::fs::read_to_string(path).map_err(|e| Failed::Spawn(e.to_string())))
}
