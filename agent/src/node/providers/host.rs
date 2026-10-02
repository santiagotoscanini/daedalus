//! What the OS says of a provider beside its HTTP answer — its install, its
//! process, its startup and, on Windows, the session it could run in — as
//! `os::lemonade::find` reads it, and the installer's log as the report
//! keeps it. The calls are the OS's (os/*/lemonade.rs, the same names on
//! every OS); this is what they share, pure and tested.

use std::path::Path;

use super::*;

/// The provider as the OS finds it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Found {
    /// The install, read off the install itself; None when there is none.
    pub install: Option<ProviderInstall>,
    /// The server's process, when one runs; on Windows its session and
    /// the account that runs it.
    pub pid: Option<u32>,
    pub session: Option<u32>,
    pub owner: Option<String>,
    pub startup: Option<ProviderStartup>,
    /// Windows: the console session the server would run in, and its
    /// user; None while nobody is logged on. Elsewhere always the default
    /// — the server is the machine's daemon and needs no one.
    pub console: Option<Console>,
    /// Windows: a per-user install in another logged-on user's profile,
    /// named by that account. The agent never touches it.
    pub foreign: Option<String>,
    /// What could not be read, in sentences.
    pub errors: Vec<String>,
}

/// The session a provider runs in for its user (Windows).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Console {
    pub session: u32,
    /// The user's SID, whose hive holds a per-user install.
    pub sid: String,
    /// `DOMAIN\user`, when the SID resolves.
    pub user: Option<String>,
}

impl Found {
    /// The server runs outside the console session — the MSI's relaunch
    /// as SYSTEM after a per-machine install — so its user's profile is
    /// not the one it reads.
    pub fn outside_console(&self) -> bool {
        match (self.session, &self.console) {
            (Some(s), Some(c)) => s != c.session,
            _ => false,
        }
    }
}

/// The most lines of an installer's log the report keeps.
pub const MAX_LOG_LINES: usize = 40;
/// The most of a log read for its tail.
const LOG_READ: u64 = 256 * 1024;

/// An installer's log as text: msiexec writes UTF-16LE with a byte-order
/// mark, the package tools UTF-8.
pub fn log_text(bytes: &[u8]) -> String {
    if let Some(rest) = bytes.strip_prefix(&[0xff, 0xfe]) {
        let units: Vec<u16> = rest
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    // A tail read from the middle of a UTF-16 file starts without its mark:
    // every other byte NUL is the tell.
    let nuls = bytes.iter().skip(1).step_by(2).filter(|b| **b == 0).count();
    if bytes.len() >= 8 && nuls * 4 >= bytes.len() {
        let start = usize::from(bytes[0] == 0);
        let units: Vec<u16> = bytes[start..]
            .chunks_exact(2)
            .map(|c| u16::from_le_bytes([c[0], c[1]]))
            .collect();
        return String::from_utf16_lossy(&units);
    }
    String::from_utf8_lossy(bytes).into_owned()
}

/// The last non-empty lines of `text`, at most `MAX_LOG_LINES`, each cut
/// to `MAX_TEXT`.
pub fn tail_lines(text: &str) -> Vec<String> {
    let lines: Vec<String> = text
        .lines()
        .map(|l| clip(l, MAX_TEXT))
        .filter(|l| !l.is_empty())
        .collect();
    let from = lines.len().saturating_sub(MAX_LOG_LINES);
    lines[from..].to_vec()
}

/// The tail of the installer's log at `path`: a regular file only, never
/// through a link (the log may sit in the user's profile), its last
/// `LOG_READ` bytes.
pub fn log_tail(path: &Path) -> Vec<String> {
    use std::io::{Read, Seek, SeekFrom};
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Vec::new();
    };
    if !meta.file_type().is_file() {
        return Vec::new();
    }
    let Ok(mut f) = std::fs::File::open(path) else {
        return Vec::new();
    };
    let from = meta.len().saturating_sub(LOG_READ);
    // An even offset keeps a UTF-16 file's code units whole.
    if f.seek(SeekFrom::Start(from & !1)).is_err() {
        return Vec::new();
    }
    let mut bytes = Vec::new();
    let _ = f.take(LOG_READ).read_to_end(&mut bytes);
    let text = log_text(&bytes);
    // The first line of a tail read mid-file is a fragment.
    let text = match text.split_once('\n') {
        Some((_, rest)) if from > 0 => rest,
        _ => &text,
    };
    tail_lines(text)
}

// ── the OS tools' words, parsed here so every OS's tests read them ────────

/// `systemctl show -p …`: one `Key=value`, empty when absent.
pub fn show_value<'a>(text: &'a str, key: &str) -> &'a str {
    text.lines()
        .find_map(|l| l.strip_prefix(key).and_then(|r| r.strip_prefix('=')))
        .map_or("", str::trim)
}

/// `dpkg-query -S <path>`: `package[:arch]: path`, the package.
pub fn dpkg_owner(text: &str) -> Option<String> {
    let line = text.lines().next()?;
    let (pkg, path) = line.split_once(": ")?;
    if !path.trim_start().starts_with('/') {
        return None;
    }
    let pkg = pkg.split(',').next()?.trim();
    (!pkg.is_empty()).then(|| pkg.to_string())
}

/// `pkgutil --pkg-info <id>`: (version, location).
pub fn pkgutil_info(text: &str) -> (Option<String>, Option<String>) {
    let get = |k: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(k))
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    let location = get("location:").map(|l| {
        let volume = get("volume:").unwrap_or_else(|| "/".into());
        format!(
            "{}/{}",
            volume.trim_end_matches('/'),
            l.trim_start_matches('/')
        )
    });
    (get("version:"), location)
}

/// `launchctl print-disabled system`: whether `label` is disabled — older
/// macOS says `true`/`false` (disabled), newer `disabled`/`enabled`. None
/// when it is not listed: enabled by default.
pub fn launchctl_disabled(text: &str, label: &str) -> Option<bool> {
    let quoted = format!("\"{label}\"");
    text.lines().find_map(|l| {
        let (k, v) = l.trim().split_once("=>")?;
        (k.trim() == quoted).then(|| matches!(v.trim(), "disabled" | "true"))
    })
}

/// Windows' `StartupApproved\StartupFolder` value for a shortcut: an even
/// first byte is enabled (`02`, `06`), an odd one disabled (`03`, `07`),
/// and no value at all is enabled.
pub fn startup_approved(value: Option<&[u8]>) -> ProviderStartup {
    match value.and_then(|v| v.first()) {
        Some(b) if b & 1 == 1 => ProviderStartup::Disabled,
        _ => ProviderStartup::Enabled,
    }
}

/// The value Task Manager writes: `02` and eleven zeros enabled; `03`,
/// three zeros and the FILETIME it was turned off at, disabled.
pub fn startup_value(on: bool, filetime: u64) -> [u8; 12] {
    let mut v = [0u8; 12];
    if on {
        v[0] = 0x02;
    } else {
        v[0] = 0x03;
        v[4..].copy_from_slice(&filetime.to_le_bytes());
    }
    v
}

/// An msiexec operation.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Msi {
    Install,
    Uninstall,
}

/// msiexec's arguments: quiet, never rebooting, a verbose log, and
/// `ALLUSERS=1` for a per-machine install — an MSI keeps the scope it was
/// installed with, and mixing them fails with 1603.
pub fn msiexec_args(op: Msi, file: &Path, log: &Path, machine: bool) -> Vec<String> {
    let mut a = vec![
        match op {
            Msi::Install => "/i",
            Msi::Uninstall => "/x",
        }
        .to_string(),
        file.display().to_string(),
        "/qn".into(),
        "/norestart".into(),
        "/l*v".into(),
        log.display().to_string(),
    ];
    if machine {
        a.push("ALLUSERS=1".into());
    }
    a
}

/// What an msiexec exit code means.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MsiExit {
    Done,
    /// Another install runs (1618): wait and try again.
    Busy,
    Failed(String),
}

pub fn msi_exit(code: u32) -> MsiExit {
    match code {
        // 3010: done, a reboot wanted (never forced: /norestart). 1605: an
        // uninstall of what is not installed — a failed upgrade the MSI
        // rolled back itself — has nothing to do.
        0 | 3010 | 1605 => MsiExit::Done,
        1618 => MsiExit::Busy,
        1603 => MsiExit::Failed("msiexec failed (1603; see its log)".into()),
        1625 | 1925 => MsiExit::Failed(format!("msiexec {code}: the account may not install it")),
        1638 => MsiExit::Failed("msiexec 1638: another version is installed".into()),
        c => MsiExit::Failed(format!("msiexec exited {c}")),
    }
}

/// How long to wait before each retry of an msiexec that found another
/// install running.
pub const MSI_BUSY_BACKOFF: [u64; 5] = [15, 30, 60, 120, 240];
