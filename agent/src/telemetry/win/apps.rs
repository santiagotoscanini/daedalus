//! Everything installed: the Uninstall keys (both views and the console
//! user's hive), the Epic launcher's manifests, and the Store packages
//! through one bounded PowerShell; each sorted as app, game, launcher,
//! runtime or driver.

use std::path::PathBuf;
use std::time::Duration;

use serde_json::Value;
use windows::core::{w, PCWSTR};
use windows::Win32::System::Registry::{HKEY, HKEY_LOCAL_MACHINE, HKEY_USERS};

use super::browsers::{console_user, unquote};
use super::powershell::{j_list, j_str, j_u64, powershell_json, script_errors};
use super::registry::{reg_dword_at, reg_subkeys, reg_sz_at};
use super::{meaningful, wide};
use crate::telemetry::App;

/// `InstallDate` as the Uninstall keys write it, "20250311", as "2025-03-11".
fn install_date(s: &str) -> Option<String> {
    let t = s.trim();
    if t.len() != 8 || !t.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    Some(format!("{}-{}-{}", &t[..4], &t[4..6], &t[6..]))
}

/// What kind of thing an installed product is, from its name: the
/// runtimes games lean on, the launchers they come through, the drivers
/// under them, and everything else is an app.
fn app_kind(name: &str) -> &'static str {
    let n = name.to_ascii_lowercase();
    let any = |needles: &[&str]| needles.iter().any(|x| n.contains(x));
    let is_word_java = n
        .split(|c: char| !c.is_ascii_alphanumeric())
        .any(|w| w == "java");
    // Launchers first: "Battle.net" would otherwise read as a .NET.
    if n == "steam"
        || any(&[
            "epic games launcher",
            "battle.net",
            "gog galaxy",
            "ubisoft connect",
            "ea app",
            "riot client",
            "gamingapp",
            "xbox",
        ])
    {
        "launcher"
    } else if any(&[
        "visual c++",
        ".net",
        "directx",
        "vulkan",
        "openal",
        "physx",
        "python 3",
        "node.js",
        "webview2",
        "windows sdk",
        "windows desktop runtime",
    ]) || is_word_java
    {
        "runtime"
    } else if any(&[
        "amd software",
        "adrenalin",
        "nvidia",
        "geforce",
        "realtek",
        "chipset",
        "windows driver package",
        "logitech g hub",
        "razer synapse",
        "corsair icue",
        "steelseries gg",
    ]) || (n.contains("intel")
        && any(&["driver", "graphics", "chipset", "management engine"]))
    {
        "driver"
    } else {
        "app"
    }
}

/// A Store package's display name from its identity: the publisher's
/// prefix dropped ("TheBrowserCompany.Arc" → "Arc") when what is left
/// reads as a name.
fn store_name(identity: &str) -> String {
    match identity.split_once('.') {
        Some((_, rest)) if rest.chars().any(char::is_alphabetic) => rest.to_string(),
        _ => identity.to_string(),
    }
}

/// The `CN=` part of a package's publisher DN ("CN=Arc Inc., O=…" → "Arc Inc.").
fn publisher_cn(dn: &str) -> Option<String> {
    dn.split(',')
        .map(str::trim)
        .find_map(|part| part.strip_prefix("CN="))
        .map(|s| s.trim().trim_matches('"').to_string())
        .filter(|s| !s.is_empty())
}

/// Store packages that are Windows itself, not something the person
/// installed: skipped by identity prefix.
fn store_is_system(identity: &str) -> bool {
    [
        "Microsoft.Windows",
        "MicrosoftWindows.",
        "Windows",
        "Microsoft.UI",
        "Microsoft.VCLibs",
        "Microsoft.NET",
        "Microsoft.DesktopAppInstaller",
        "Microsoft.SecHealthUI",
        "Microsoft.StorePurchaseApp",
        "Microsoft.WindowsStore",
        // The Xbox app's own overlays and sign-in helper, registered beside it.
        "Microsoft.Xbox.TCUI",
        "Microsoft.XboxGameOverlay",
        "Microsoft.XboxGamingOverlay",
        "Microsoft.XboxIdentityProvider",
        "Microsoft.XboxSpeechToTextOverlay",
        "Microsoft.XboxGameCallableUI",
    ]
    .iter()
    .any(|p| identity.starts_with(p))
}

const UNINSTALL: &str = r"SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall";
const UNINSTALL_WOW: &str = r"SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall";
/// Where the Epic launcher keeps one manifest per installed game.
const EPIC_MANIFESTS: &str = r"Epic\EpicGamesLauncher\Data\Manifests";
/// How long the Store enumeration may take: `Get-AppxPackage -AllUsers`
/// walks every user's package registrations and a slow disk can make it
/// half a minute.
const STORE_DEADLINE: Duration = Duration::from_secs(60);

/// The Store packages, through the only surface that lists them: the Appx
/// cmdlets. Frameworks and resource packs are parts of other packages, and
/// only what carries a Store signature is something a person installed
/// (the rest are Windows's own, sideloads and developer builds). `Version`
/// is a `System.Version`, which `ConvertTo-Json` would spread into four
/// fields; cast to a string. Single quotes only, as the other scripts.
const STORE_SCRIPT: &str = r"
$ErrorActionPreference = 'Stop'
$out = @{ packages = @(); errors = @() }
try {
  $out.packages = @(Get-AppxPackage -AllUsers | Where-Object { -not $_.IsFramework -and -not $_.IsResourcePackage -and [string]$_.SignatureKind -eq 'Store' } |
    Select-Object Name, @{n='Version';e={[string]$_.Version}}, Publisher, InstallLocation, PackageFullName)
} catch { $out.errors += ('Get-AppxPackage|' + $_.Exception.Message) }
[pscustomobject]$out | ConvertTo-Json -Compress -Depth 3
";

/// One product from an Uninstall key, or None when the key is not a
/// product a person would list: no display name, a system component, a
/// patch (it names a parent), or a Windows update that registered here.
fn uninstall_entry(root: HKEY, base: &str, key: &str) -> Option<App> {
    let sub = wide(&format!(r"{base}\{key}"));
    let sub = PCWSTR(sub.as_ptr());
    let name = reg_sz_at(root, sub, w!("DisplayName")).and_then(|n| meaningful(&n))?;
    if reg_dword_at(root, sub, w!("SystemComponent")) == Some(1)
        || reg_sz_at(root, sub, w!("ParentKeyName")).is_some()
        || is_update_name(&name)
    {
        return None;
    }
    let steam = key.starts_with("Steam App ");
    Some(App {
        version: reg_sz_at(root, sub, w!("DisplayVersion")).and_then(|v| meaningful(&v)),
        publisher: reg_sz_at(root, sub, w!("Publisher")).and_then(|p| meaningful(&p)),
        installed_at: reg_sz_at(root, sub, w!("InstallDate")).and_then(|d| install_date(&d)),
        size_bytes: reg_dword_at(root, sub, w!("EstimatedSize"))
            .filter(|&kib| kib > 0)
            .map(|kib| u64::from(kib) * 1024),
        kind: if steam { "game" } else { app_kind(&name) }.into(),
        source: Some(if steam { "steam" } else { "registry" }.into()),
        path: reg_sz_at(root, sub, w!("InstallLocation"))
            .map(|p| unquote(&p).to_string())
            .filter(|p| !p.is_empty()),
        name,
    })
}

/// Whether an Uninstall display name is a Windows update rather than a
/// product: "KB5043076", "Update for …", "Security Update for …".
fn is_update_name(name: &str) -> bool {
    let kb = name
        .strip_prefix("KB")
        .is_some_and(|rest| rest.chars().next().is_some_and(|c| c.is_ascii_digit()));
    kb || ["Update for ", "Security Update for ", "Hotfix for "]
        .iter()
        .any(|p| name.starts_with(p))
}

/// Every product under one Uninstall root.
fn uninstall_apps(root: HKEY, base: &str, out: &mut Vec<App>, errors: &mut Vec<String>) {
    let sub = wide(base);
    match reg_subkeys(root, PCWSTR(sub.as_ptr())) {
        Ok(keys) => out.extend(keys.iter().filter_map(|k| uninstall_entry(root, base, k))),
        // The 32-bit view and a user's hive may simply not have the key.
        Err(e) if e.starts_with("RegOpenKeyEx") => {}
        Err(e) => errors.push(format!("apps: {base} not enumerable: {e}")),
    }
}

/// One Epic manifest (`*.item`, JSON) as a game.
fn parse_epic_manifest(v: &Value) -> Option<App> {
    let name = j_str(v, "DisplayName")?;
    Some(App {
        version: j_str(v, "AppVersionString"),
        publisher: None,
        installed_at: None,
        size_bytes: j_u64(v, "InstallSize").filter(|&b| b > 0),
        kind: "game".into(),
        source: Some("epic".into()),
        path: j_str(v, "InstallLocation"),
        name,
    })
}

/// The games the Epic launcher has installed, from its manifests. No
/// launcher, no directory, nothing to say.
fn epic_apps(errors: &mut Vec<String>) -> Vec<App> {
    let Some(data) = std::env::var_os("ProgramData") else {
        return Vec::new();
    };
    let dir = PathBuf::from(data).join(EPIC_MANIFESTS);
    let entries = match std::fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Vec::new(),
        Err(e) => {
            errors.push(format!("apps: Epic manifests not readable: {e}"));
            return Vec::new();
        }
    };
    entries
        .flatten()
        .filter(|e| {
            e.path()
                .extension()
                .is_some_and(|x| x.eq_ignore_ascii_case("item"))
        })
        .filter_map(|e| std::fs::read_to_string(e.path()).ok())
        .filter_map(|t| serde_json::from_str::<Value>(&t).ok())
        .filter_map(|v| parse_epic_manifest(&v))
        .collect()
}

/// The Store packages from the script's document, Windows's own left out.
fn parse_store(v: &Value) -> Vec<App> {
    j_list(v, "packages")
        .iter()
        .filter_map(|p| {
            let identity = j_str(p, "Name")?;
            if store_is_system(&identity) {
                return None;
            }
            let name = store_name(&identity);
            Some(App {
                version: j_str(p, "Version"),
                publisher: j_str(p, "Publisher").and_then(|d| publisher_cn(&d)),
                installed_at: None,
                size_bytes: None,
                kind: app_kind(&name).into(),
                source: Some("store".into()),
                path: j_str(p, "InstallLocation"),
                name,
            })
        })
        .collect()
}

/// Everything installed, from the four places Windows records it: the
/// Uninstall keys (both views, and the console user's own hive for
/// per-user installs), the Epic manifests, and the Store through one
/// PowerShell with a deadline. The registry and the manifests are
/// microseconds; the Store is the only wait, and it is bounded.
pub(super) fn read_apps(errors: &mut Vec<String>) -> Vec<App> {
    let mut out = Vec::new();
    uninstall_apps(HKEY_LOCAL_MACHINE, UNINSTALL, &mut out, errors);
    uninstall_apps(HKEY_LOCAL_MACHINE, UNINSTALL_WOW, &mut out, errors);
    if let Some(u) = console_user(errors) {
        uninstall_apps(
            HKEY_USERS,
            &format!(r"{}\{UNINSTALL}", u.sid),
            &mut out,
            errors,
        );
    }
    out.extend(epic_apps(errors));
    match powershell_json(STORE_SCRIPT, STORE_DEADLINE) {
        Ok(v) => {
            errors.extend(script_errors(&v, |_| "apps".to_string()));
            out.extend(parse_store(&v));
        }
        Err(e) => errors.push(format!("apps: Store packages not read: {e}")),
    }
    crate::telemetry::tidy_apps(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_kinds_and_store_names() {
        assert_eq!(
            app_kind("Microsoft Visual C++ 2015-2022 Redistributable (x64)"),
            "runtime"
        );
        assert_eq!(app_kind("Microsoft .NET Runtime - 8.0.11 (x64)"), "runtime");
        assert_eq!(app_kind("Java 8 Update 401"), "runtime");
        assert_eq!(app_kind("JavaScript Tools"), "app");
        assert_eq!(app_kind("Steam"), "launcher");
        assert_eq!(app_kind("Epic Games Launcher"), "launcher");
        assert_eq!(app_kind("GamingApp"), "launcher");
        assert_eq!(app_kind("Battle.net"), "launcher");
        assert!(store_is_system("Microsoft.XboxGamingOverlay"));
        assert_eq!(app_kind("AMD Software"), "driver");
        assert_eq!(app_kind("Intel(R) Chipset Device Software"), "driver");
        assert_eq!(app_kind("Intel Unison"), "app");
        assert_eq!(app_kind("Logitech G HUB"), "driver");
        assert_eq!(app_kind("Discord"), "app");
        assert!(is_update_name("KB5043076"));
        assert!(is_update_name("Security Update for Microsoft Office"));
        assert!(!is_update_name("KBase Client"));
        assert_eq!(store_name("TheBrowserCompany.Arc"), "Arc");
        assert_eq!(store_name("Microsoft.GamingApp"), "GamingApp");
        assert_eq!(store_name("Arc"), "Arc");
        assert_eq!(store_name("Foo.1234"), "Foo.1234");
        assert_eq!(
            publisher_cn("CN=The Browser Company of New York, O=The Browser Company, L=New York")
                .as_deref(),
            Some("The Browser Company of New York")
        );
        assert!(store_is_system("Microsoft.WindowsCalculator"));
        assert!(store_is_system("MicrosoftWindows.Client.WebExperience"));
        assert!(!store_is_system("Microsoft.GamingApp"));
        assert!(!store_is_system("TheBrowserCompany.Arc"));
    }

    #[test]
    fn epic_manifest_and_store_document() {
        let v: Value = serde_json::from_str(
            r#"{"DisplayName":"Alan Wake 2","AppVersionString":"1.2.3","InstallLocation":"D:\\Games\\AlanWake2","InstallSize":89000000000}"#,
        )
        .unwrap();
        let a = parse_epic_manifest(&v).expect("a game");
        assert_eq!(a.name, "Alan Wake 2");
        assert_eq!(a.version.as_deref(), Some("1.2.3"));
        assert_eq!(a.kind, "game");
        assert_eq!(a.source.as_deref(), Some("epic"));
        assert_eq!(a.size_bytes, Some(89_000_000_000));
        assert_eq!(a.path.as_deref(), Some(r"D:\Games\AlanWake2"));
        assert!(parse_epic_manifest(&serde_json::json!({"AppVersionString": "1"})).is_none());

        let doc: Value = serde_json::from_str(
            r#"{"packages":[
              {"Name":"TheBrowserCompany.Arc","Version":"1.115.1.2","Publisher":"CN=The Browser Company of New York, O=x","InstallLocation":"C:\\Program Files\\WindowsApps\\TheBrowserCompany.Arc_1.115.1.2_x64__abc"},
              {"Name":"Microsoft.WindowsCalculator","Version":"11.0","Publisher":"CN=Microsoft Corporation","InstallLocation":null},
              {"Name":"Microsoft.GamingApp","Version":"2509.1","Publisher":"CN=Microsoft Corporation, O=Microsoft Corporation","InstallLocation":"C:\\x"}
            ],"errors":[]}"#,
        )
        .unwrap();
        let apps = parse_store(&doc);
        assert_eq!(apps.len(), 2);
        assert_eq!(apps[0].name, "Arc");
        assert_eq!(apps[0].version.as_deref(), Some("1.115.1.2"));
        assert_eq!(
            apps[0].publisher.as_deref(),
            Some("The Browser Company of New York")
        );
        assert_eq!(apps[0].source.as_deref(), Some("store"));
        assert_eq!(apps[0].kind, "app");
        assert_eq!(apps[1].name, "GamingApp");
        assert_eq!(apps[1].kind, "launcher");
    }

    #[test]
    fn install_date_from_uninstall_key() {
        assert_eq!(install_date("20250311").as_deref(), Some("2025-03-11"));
        assert_eq!(install_date("2025-03-11"), None);
        assert_eq!(install_date(""), None);
    }
}
