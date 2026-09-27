//! The Chromium-family browsers installed: `App Paths` in HKLM, its 32-bit
//! view and the console user's hive, then the well-known install
//! directories; the version from the exe's resource or the version
//! directory beside it; whether one is running; the console user's default.
//! The console user (the session token, or the logged-on hive) lives here
//! too, and the apps tier reads it for per-user installs.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use windows::core::{w, PCWSTR, PWSTR};
use windows::Win32::Foundation::{CloseHandle, LocalFree, HANDLE, HLOCAL};
use windows::Win32::Security::Authorization::ConvertSidToStringSidW;
use windows::Win32::Security::{GetTokenInformation, TokenUser, TOKEN_USER};
use windows::Win32::Storage::FileSystem::{
    GetFileVersionInfoSizeW, GetFileVersionInfoW, VerQueryValueW, VS_FIXEDFILEINFO,
};
use windows::Win32::System::Registry::{HKEY, HKEY_LOCAL_MACHINE, HKEY_USERS};
use windows::Win32::System::RemoteDesktop::{WTSGetActiveConsoleSessionId, WTSQueryUserToken};

use super::processes::process_snapshot;
use super::registry::{reg_key_exists_at, reg_subkeys, reg_sz_at};
use super::wide;
use crate::telemetry::Browser;

/// The release channel an install path names, "stable" when it names
/// none. The product directory carries it — `Chrome Beta`, `Edge SxS`
/// (canary), `Brave-Browser-Nightly` — never the exe, which is the same
/// name on every channel.
fn channel_from_path(path: &str) -> &'static str {
    let p = path.to_ascii_lowercase();
    let has = |needles: &[&str]| needles.iter().any(|n| p.contains(n));
    if has(&[
        "chrome beta",
        "edge beta",
        "brave-browser-beta",
        "opera beta",
    ]) {
        "beta"
    } else if has(&[
        "chrome dev",
        "edge dev",
        "brave-browser-dev",
        "opera developer",
    ]) {
        "dev"
    } else if has(&["chrome sxs", "edge sxs", "brave-browser-nightly"]) {
        "canary"
    } else {
        "stable"
    }
}

/// Where a channel sorts on the page: stable first, then the ones that
/// move faster.
fn channel_rank(channel: Option<&str>) -> u8 {
    match channel {
        Some("stable") | None => 0,
        Some("beta") => 1,
        Some("dev") => 2,
        _ => 3,
    }
}

/// The (kind, channel) a `UserChoice` ProgId names. Chrome's per-user
/// install suffixes its ProgId with a hash (`ChromeHTML.ABCDEF…`), and
/// its other channels change the letters before `HTML` (`ChromeBHTML`,
/// `ChromeDHTML`, `ChromeSSHTML`); Edge and Brave follow the same scheme
/// on `HTM` / `HTML`; Opera names the channel in words.
fn kind_from_progid(progid: &str) -> Option<(&'static str, &'static str)> {
    let p = progid
        .trim()
        .split('.')
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    Some(match p.as_str() {
        "chromehtml" => ("chrome", "stable"),
        "chromebhtml" => ("chrome", "beta"),
        "chromedhtml" => ("chrome", "dev"),
        "chromesshtml" => ("chrome", "canary"),
        "msedgehtm" => ("edge", "stable"),
        "msedgebhtm" => ("edge", "beta"),
        "msedgedhtm" => ("edge", "dev"),
        "msedgesshtm" => ("edge", "canary"),
        "bravehtml" => ("brave", "stable"),
        "bravebhtml" => ("brave", "beta"),
        "bravedhtml" => ("brave", "dev"),
        "bravesshtml" => ("brave", "canary"),
        "archtml" => ("arc", "stable"),
        "chromiumhtm" => ("chromium", "stable"),
        "operastable" => ("opera", "stable"),
        "operabeta" => ("opera", "beta"),
        "operadeveloper" => ("opera", "dev"),
        s if s.starts_with("vivaldihtm") => ("vivaldi", "stable"),
        _ => return None,
    })
}

/// "128.0.6613.120" from the two DWORDs a `VS_FIXEDFILEINFO` packs a
/// version into; None for 0.0.0.0, which is a resource with no version.
fn version_from_parts(ms: u32, ls: u32) -> Option<String> {
    (ms != 0 || ls != 0)
        .then(|| format!("{}.{}.{}.{}", ms >> 16, ms & 0xFFFF, ls >> 16, ls & 0xFFFF))
}

/// A directory name of the `NNN.N.NNNN.NNN` shape Chromium keeps its
/// versioned files under, as its four numbers.
fn version_dir(name: &str) -> Option<[u64; 4]> {
    let mut parts = name.split('.');
    let mut out = [0u64; 4];
    for slot in &mut out {
        let p = parts.next()?;
        if p.is_empty() || !p.chars().all(|c| c.is_ascii_digit()) {
            return None;
        }
        *slot = p.parse().ok()?;
    }
    parts.next().is_none().then_some(out)
}

/// The highest version among directory names, as it was spelled: what a
/// browser that keeps its last two versions beside the exe is running.
fn highest_version_dir<I: IntoIterator<Item = String>>(names: I) -> Option<String> {
    names
        .into_iter()
        .filter_map(|n| version_dir(&n).map(|v| (v, n)))
        .max_by(|a, b| a.0.cmp(&b.0))
        .map(|(_, n)| n)
}

/// An `App Paths` value as a path: some installers quote it.
pub(super) fn unquote(s: &str) -> &str {
    let t = s.trim();
    t.strip_prefix('"')
        .and_then(|t| t.strip_suffix('"'))
        .unwrap_or(t)
        .trim()
}

/// A Chromium browser the collector looks for: the exe names that register
/// it under `App Paths` (Opera registers its launcher, whose path names
/// the Opera directory) and what the page calls it.
struct BrowserKind {
    kind: &'static str,
    name: &'static str,
    exes: &'static [&'static str],
}

const BROWSER_KINDS: &[BrowserKind] = &[
    BrowserKind {
        kind: "chrome",
        name: "Google Chrome",
        exes: &["chrome.exe"],
    },
    BrowserKind {
        kind: "edge",
        name: "Microsoft Edge",
        exes: &["msedge.exe"],
    },
    BrowserKind {
        kind: "brave",
        name: "Brave",
        exes: &["brave.exe"],
    },
    BrowserKind {
        kind: "arc",
        name: "Arc",
        exes: &["Arc.exe"],
    },
    BrowserKind {
        kind: "chromium",
        name: "Chromium",
        exes: &["chromium.exe"],
    },
    BrowserKind {
        kind: "vivaldi",
        name: "Vivaldi",
        exes: &["vivaldi.exe"],
    },
    BrowserKind {
        kind: "opera",
        name: "Opera",
        exes: &["opera.exe", "launcher.exe"],
    },
];

/// Where each kind installs when the registry names nothing, relative to
/// Program Files, Program Files (x86) and the console user's Local
/// AppData (a per-user Chrome, Edge or Brave lives there; Opera's
/// per-user tree is under `Programs`). Every channel has its own
/// directory, so each is a row; a bare Chromium build ships its exe as
/// `chrome.exe` under a `Chromium` directory. Arc has no row: it is an
/// MSIX package under `WindowsApps`, reachable only through the registry.
const WELL_KNOWN: &[(&str, &str)] = &[
    ("chrome", r"Google\Chrome\Application\chrome.exe"),
    ("chrome", r"Google\Chrome Beta\Application\chrome.exe"),
    ("chrome", r"Google\Chrome Dev\Application\chrome.exe"),
    ("chrome", r"Google\Chrome SxS\Application\chrome.exe"),
    ("edge", r"Microsoft\Edge\Application\msedge.exe"),
    ("edge", r"Microsoft\Edge Beta\Application\msedge.exe"),
    ("edge", r"Microsoft\Edge Dev\Application\msedge.exe"),
    ("edge", r"Microsoft\Edge SxS\Application\msedge.exe"),
    (
        "brave",
        r"BraveSoftware\Brave-Browser\Application\brave.exe",
    ),
    (
        "brave",
        r"BraveSoftware\Brave-Browser-Beta\Application\brave.exe",
    ),
    (
        "brave",
        r"BraveSoftware\Brave-Browser-Nightly\Application\brave.exe",
    ),
    ("chromium", r"Chromium\Application\chrome.exe"),
    ("vivaldi", r"Vivaldi\Application\vivaldi.exe"),
    ("opera", r"Opera\launcher.exe"),
    ("opera", r"Opera beta\launcher.exe"),
    ("opera", r"Opera developer\launcher.exe"),
    ("opera", r"Programs\Opera\launcher.exe"),
    ("opera", r"Programs\Opera beta\launcher.exe"),
    ("opera", r"Programs\Opera developer\launcher.exe"),
];

const APP_PATHS: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths";
const APP_PATHS_WOW: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\App Paths";
const HTTP_USER_CHOICE: &str =
    r"SOFTWARE\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice";

/// The user at the console, as the registry knows them: the SID their
/// hive is loaded under, and their Local AppData where the hive says.
pub(super) struct ConsoleUser {
    pub(super) sid: String,
    local_appdata: Option<PathBuf>,
}

/// The SID of the console session's user, from the token the service may
/// take as LocalSystem (the same call that starts the tray). None when
/// nobody is at the console, or the token is refused — this process is not
/// the service.
fn console_sid_from_token() -> Option<String> {
    // SAFETY: the token handle is written on success and closed on every
    // path; the SID string is freed after it is copied out.
    unsafe {
        let session = WTSGetActiveConsoleSessionId();
        if session == 0xFFFF_FFFF {
            return None;
        }
        let mut token = HANDLE::default();
        WTSQueryUserToken(session, &mut token).ok()?;
        let sid = token_user_sid(token);
        let _ = CloseHandle(token);
        sid
    }
}

/// The string SID of a token's user.
///
/// # Safety
/// `token` is an open token handle with TOKEN_QUERY access.
unsafe fn token_user_sid(token: HANDLE) -> Option<String> {
    let mut len: u32 = 0;
    // A size query: it fails with ERROR_INSUFFICIENT_BUFFER and the size.
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
    if len == 0 {
        return None;
    }
    // u64-backed so the TOKEN_USER (a pointer and a u32) is aligned.
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    GetTokenInformation(
        token,
        TokenUser,
        Some(buf.as_mut_ptr().cast()),
        len,
        &mut len,
    )
    .ok()?;
    let user = &*buf.as_ptr().cast::<TOKEN_USER>();
    let mut s = PWSTR::null();
    ConvertSidToStringSidW(user.User.Sid, &mut s).ok()?;
    if s.is_null() {
        return None;
    }
    let out = String::from_utf16_lossy(s.as_wide());
    let _ = LocalFree(Some(HLOCAL(s.0.cast())));
    (!out.is_empty()).then_some(out)
}

/// The loaded hives under `HKEY_USERS` that belong to logged-on accounts:
/// an `S-1-5-21-…` SID (not its `_Classes` twin) with a `Volatile
/// Environment` key, which logon writes and logoff unloads.
fn logged_on_sids() -> Result<Vec<String>, String> {
    let names = reg_subkeys(HKEY_USERS, PCWSTR::null())?;
    Ok(names
        .into_iter()
        .filter(|n| n.starts_with("S-1-5-21-") && !n.ends_with("_Classes"))
        .filter(|n| {
            let sub = wide(&format!(r"{n}\Volatile Environment"));
            reg_key_exists_at(HKEY_USERS, PCWSTR(sub.as_ptr()))
        })
        .collect())
}

/// The console user: from the session token when this is the service,
/// else the first logged-on hive. None when nobody is logged on.
pub(super) fn console_user(errors: &mut Vec<String>) -> Option<ConsoleUser> {
    let sid = console_sid_from_token().or_else(|| match logged_on_sids() {
        Ok(sids) => sids.into_iter().next(),
        Err(e) => {
            errors.push(format!("browsers: HKEY_USERS not enumerable: {e}"));
            None
        }
    })?;
    // Where the user's own installs go. `Volatile Environment` is what
    // logon wrote for THAT user; this process's %LOCALAPPDATA% is the
    // service's.
    let env = wide(&format!(r"{sid}\Volatile Environment"));
    let env = PCWSTR(env.as_ptr());
    let local_appdata = reg_sz_at(HKEY_USERS, env, w!("LOCALAPPDATA"))
        .map(PathBuf::from)
        .or_else(|| {
            reg_sz_at(HKEY_USERS, env, w!("USERPROFILE"))
                .map(|p| PathBuf::from(p).join(r"AppData\Local"))
        });
    Some(ConsoleUser { sid, local_appdata })
}

/// The `App Paths\<exe>` default value under a root, as a path.
fn app_path(root: HKEY, base: &str, exe: &str) -> Option<PathBuf> {
    let sub = wide(&format!(r"{base}\{exe}"));
    reg_sz_at(root, PCWSTR(sub.as_ptr()), PCWSTR::null())
        .map(|v| unquote(&v).to_string())
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
}

/// The four-part version stamped in an exe's version resource: the file
/// version, or the product version when the file's reads 0.0.0.0. None
/// when the file has no resource or it cannot be read.
fn file_version(path: &Path) -> Option<String> {
    let name = wide(&path.to_string_lossy());
    let name = PCWSTR(name.as_ptr());
    // SAFETY: a size query, a read into a buffer of that size, then a
    // query for the root block, which points inside that buffer; the
    // fixed-info struct is read unaligned from there.
    unsafe {
        let size = GetFileVersionInfoSizeW(name, None);
        if size == 0 {
            return None;
        }
        let mut buf = vec![0u64; (size as usize).div_ceil(8)];
        GetFileVersionInfoW(name, None, size, buf.as_mut_ptr().cast()).ok()?;
        let mut p: *mut std::ffi::c_void = std::ptr::null_mut();
        let mut len: u32 = 0;
        if !VerQueryValueW(buf.as_ptr().cast(), w!(r"\"), &mut p, &mut len).as_bool()
            || p.is_null()
            || (len as usize) < std::mem::size_of::<VS_FIXEDFILEINFO>()
        {
            return None;
        }
        let info = p.cast::<VS_FIXEDFILEINFO>().read_unaligned();
        // VS_FFI_SIGNATURE: anything else is not a fixed-info block.
        if info.dwSignature != 0xFEEF_04BD {
            return None;
        }
        version_from_parts(info.dwFileVersionMS, info.dwFileVersionLS)
            .or_else(|| version_from_parts(info.dwProductVersionMS, info.dwProductVersionLS))
    }
}

/// The version directory beside an exe: Chromium installs keep
/// `Application\<version>\` next to `chrome.exe`, the highest being the
/// one that runs.
fn version_dir_beside(exe: &Path) -> Option<String> {
    let dir = exe.parent()?.read_dir().ok()?;
    highest_version_dir(dir.filter_map(|e| {
        let e = e.ok()?;
        if !e.file_type().ok()?.is_dir() {
            return None;
        }
        Some(e.file_name().to_string_lossy().into_owned())
    }))
}

/// The Chromium browsers installed: every candidate path the registry and
/// the well-known directories name, in that order, the first existing
/// file per (kind, channel) kept.
pub(super) fn read_browsers(errors: &mut Vec<String>) -> Vec<Browser> {
    let user = console_user(errors);
    let user_hive = user.as_ref().map(|u| u.sid.clone());

    // Candidates, registry first: HKLM, its 32-bit view, the user's hive.
    let mut candidates: Vec<(&BrowserKind, PathBuf)> = Vec::new();
    for k in BROWSER_KINDS {
        for exe in k.exes {
            let found = [
                app_path(HKEY_LOCAL_MACHINE, APP_PATHS, exe),
                app_path(HKEY_LOCAL_MACHINE, APP_PATHS_WOW, exe),
                user_hive
                    .as_ref()
                    .and_then(|sid| app_path(HKEY_USERS, &format!(r"{sid}\{APP_PATHS}"), exe)),
            ];
            for p in found.into_iter().flatten() {
                // `launcher.exe` is Opera's only when its path says so;
                // other products register a launcher of that name too.
                if exe.eq_ignore_ascii_case("launcher.exe")
                    && !p.to_string_lossy().to_ascii_lowercase().contains("opera")
                {
                    continue;
                }
                candidates.push((k, p));
            }
        }
    }
    // Then the well-known directories, under each root that exists.
    let mut roots: Vec<PathBuf> = ["ProgramFiles", "ProgramFiles(x86)"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect();
    if let Some(lad) = user.as_ref().and_then(|u| u.local_appdata.clone()) {
        roots.push(lad);
    }
    for root in &roots {
        for (kind, rel) in WELL_KNOWN {
            if let Some(k) = BROWSER_KINDS.iter().find(|k| k.kind == *kind) {
                candidates.push((k, root.join(rel)));
            }
        }
    }

    // What is running, by image name, from a fresh process snapshot.
    let running: HashSet<String> = match process_snapshot() {
        Ok(entries) => entries
            .into_iter()
            .map(|(_, name)| name.to_ascii_lowercase())
            .collect(),
        Err(e) => {
            errors.push(format!("browsers: whether one is running is unknown: {e}"));
            HashSet::new()
        }
    };
    // The default for http, from the console user's UserChoice.
    let default = match &user {
        Some(u) => {
            let sub = wide(&format!(r"{}\{HTTP_USER_CHOICE}", u.sid));
            reg_sz_at(HKEY_USERS, PCWSTR(sub.as_ptr()), w!("ProgId"))
                .and_then(|p| kind_from_progid(&p))
        }
        None => {
            errors.push("default browser: nobody is logged on".into());
            None
        }
    };

    let mut out: Vec<Browser> = Vec::new();
    for (k, path) in candidates {
        if !path.is_file() {
            continue;
        }
        let shown = path.to_string_lossy().into_owned();
        let channel = channel_from_path(&shown);
        if out
            .iter()
            .any(|b| b.kind == k.kind && b.channel.as_deref() == Some(channel))
        {
            continue;
        }
        let version = file_version(&path).or_else(|| version_dir_beside(&path));
        if version.is_none() {
            errors.push(format!(
                "{} ({channel}): version is not readable from the exe or its install directory",
                k.name
            ));
        }
        // Opera's launcher hands off to `opera.exe` and exits; every other
        // kind's main process is the exe itself.
        let image = if k.kind == "opera" {
            "opera.exe".to_string()
        } else {
            path.file_name()
                .map(|n| n.to_string_lossy().to_ascii_lowercase())
                .unwrap_or_default()
        };
        out.push(Browser {
            name: k.name.to_string(),
            kind: k.kind.to_string(),
            version,
            channel: Some(channel.to_string()),
            path: Some(shown),
            running: running.contains(&image),
            default_browser: default == Some((k.kind, channel)),
        });
    }
    out.sort_by(|a, b| {
        a.kind
            .cmp(&b.kind)
            .then(channel_rank(a.channel.as_deref()).cmp(&channel_rank(b.channel.as_deref())))
    });
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn channel_from_install_path() {
        assert_eq!(
            channel_from_path(r"C:\Program Files\Google\Chrome\Application\chrome.exe"),
            "stable"
        );
        assert_eq!(
            channel_from_path(
                r"C:\Users\x\AppData\Local\Google\Chrome Beta\Application\chrome.exe"
            ),
            "beta"
        );
        assert_eq!(
            channel_from_path(r"C:\Program Files\Google\Chrome Dev\Application\chrome.exe"),
            "dev"
        );
        assert_eq!(
            channel_from_path(r"C:\Users\x\AppData\Local\Google\Chrome SxS\Application\chrome.exe"),
            "canary"
        );
        assert_eq!(
            channel_from_path(r"C:\Program Files (x86)\Microsoft\Edge SxS\Application\msedge.exe"),
            "canary"
        );
        assert_eq!(
            channel_from_path(
                r"C:\Program Files\BraveSoftware\Brave-Browser-Nightly\Application\brave.exe"
            ),
            "canary"
        );
        assert_eq!(
            channel_from_path(
                r"C:\Program Files\BraveSoftware\Brave-Browser-Beta\Application\brave.exe"
            ),
            "beta"
        );
        assert_eq!(
            channel_from_path(r"C:\Users\x\AppData\Local\Programs\Opera developer\launcher.exe"),
            "dev"
        );
        assert!(channel_rank(Some("stable")) < channel_rank(Some("beta")));
        assert!(channel_rank(Some("beta")) < channel_rank(Some("dev")));
        assert!(channel_rank(Some("dev")) < channel_rank(Some("canary")));
    }

    #[test]
    fn kind_from_user_choice_progid() {
        assert_eq!(kind_from_progid("ChromeHTML"), Some(("chrome", "stable")));
        // A per-user Chrome suffixes its ProgId with a hash.
        assert_eq!(
            kind_from_progid("ChromeHTML.HZ3ZKQK4LQMQZ7QCUHY4DQ2LXM"),
            Some(("chrome", "stable"))
        );
        assert_eq!(kind_from_progid("ChromeSSHTML"), Some(("chrome", "canary")));
        assert_eq!(kind_from_progid("MSEdgeHTM"), Some(("edge", "stable")));
        assert_eq!(kind_from_progid("MSEdgeBHTM"), Some(("edge", "beta")));
        assert_eq!(kind_from_progid("BraveHTML"), Some(("brave", "stable")));
        assert_eq!(kind_from_progid("ArcHTML"), Some(("arc", "stable")));
        assert_eq!(
            kind_from_progid("ChromiumHTM"),
            Some(("chromium", "stable"))
        );
        assert_eq!(
            kind_from_progid("VivaldiHTM.ABCDEF"),
            Some(("vivaldi", "stable"))
        );
        assert_eq!(kind_from_progid("OperaStable"), Some(("opera", "stable")));
        assert_eq!(kind_from_progid("OperaBeta"), Some(("opera", "beta")));
        assert_eq!(kind_from_progid("FirefoxURL-308046B0AF4A39CB"), None);
        assert_eq!(kind_from_progid(""), None);
    }

    #[test]
    fn version_from_fixed_file_info() {
        // 128.0.6613.120: HIWORD.LOWORD of each DWORD.
        assert_eq!(
            version_from_parts(128 << 16, (6613 << 16) | 120).as_deref(),
            Some("128.0.6613.120")
        );
        assert_eq!(version_from_parts(0, 0), None);
    }

    #[test]
    fn highest_version_directory_beside_exe() {
        let names = [
            "128.0.6613.84",
            "128.0.6613.120",
            "Dictionaries",
            "9.9.9",
            "127.0.6533.100",
            "SetupMetrics",
        ]
        .iter()
        .map(|s| s.to_string());
        assert_eq!(
            highest_version_dir(names).as_deref(),
            Some("128.0.6613.120")
        );
        // Numeric, not lexical: 9 < 10 per part.
        let names = ["9.0.0.0", "10.0.0.0"].iter().map(|s| s.to_string());
        assert_eq!(highest_version_dir(names).as_deref(), Some("10.0.0.0"));
        assert_eq!(highest_version_dir(Vec::<String>::new()), None);
        assert_eq!(version_dir("1.2.3.4.5"), None);
        assert_eq!(version_dir("1.2.3"), None);
        assert_eq!(version_dir("1.2.3.x"), None);
    }

    #[test]
    fn app_paths_values_lose_their_quotes() {
        assert_eq!(
            unquote(r#""C:\Program Files\Opera\launcher.exe""#),
            r"C:\Program Files\Opera\launcher.exe"
        );
        assert_eq!(
            unquote(r"  C:\Program Files\Google\Chrome\Application\chrome.exe "),
            r"C:\Program Files\Google\Chrome\Application\chrome.exe"
        );
        assert_eq!(unquote(r#"""#), r#"""#);
    }
}
