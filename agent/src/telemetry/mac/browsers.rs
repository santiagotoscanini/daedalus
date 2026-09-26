//! The Chromium-family browsers installed: the known bundles under
//! `/Applications` and the console user's `~/Applications`, each one's
//! version and bundle id from its `Info.plist`, whether it has a process
//! alive, and which one LaunchServices opens `http` with. The console
//! user's home (`stat` on /dev/console, then `dscl`) lives here too; the
//! apps tier reads the same folders.

use std::path::Path;
use std::process::Command;

use super::parse::{plist_dicts, plist_string};
use super::run::{output, output_or, plist_xml};
use super::{APPLICATIONS, CONSOLE_USER, PLIST, PS};
use crate::telemetry::Browser;

/// LaunchServices' handler list, under the user's home: which app opens
/// each URL scheme and content type. Binary on disk.
const LS_HANDLERS: &str =
    "Library/Preferences/com.apple.launchservices/com.apple.launchservices.secure.plist";
/// The Chromium browsers looked for: the bundle's name under an
/// Applications folder, then the kind, display name and channel it stands
/// for. Firefox and Safari are not Chromium and are not here.
const BROWSER_BUNDLES: &[(&str, &str, &str, &str)] = &[
    ("Google Chrome.app", "chrome", "Google Chrome", "stable"),
    ("Google Chrome Beta.app", "chrome", "Google Chrome", "beta"),
    ("Google Chrome Dev.app", "chrome", "Google Chrome", "dev"),
    (
        "Google Chrome Canary.app",
        "chrome",
        "Google Chrome",
        "canary",
    ),
    ("Microsoft Edge.app", "edge", "Microsoft Edge", "stable"),
    ("Microsoft Edge Beta.app", "edge", "Microsoft Edge", "beta"),
    ("Microsoft Edge Dev.app", "edge", "Microsoft Edge", "dev"),
    (
        "Microsoft Edge Canary.app",
        "edge",
        "Microsoft Edge",
        "canary",
    ),
    ("Brave Browser.app", "brave", "Brave", "stable"),
    ("Brave Browser Beta.app", "brave", "Brave", "beta"),
    ("Brave Browser Nightly.app", "brave", "Brave", "canary"),
    ("Arc.app", "arc", "Arc", "stable"),
    ("Chromium.app", "chromium", "Chromium", "stable"),
    ("Vivaldi.app", "vivaldi", "Vivaldi", "stable"),
    ("Opera.app", "opera", "Opera", "stable"),
];

/// The kind, display name and channel a bundle name stands for, when it is
/// one of the Chromium browsers looked for ("Google Chrome Beta.app" →
/// chrome, "Google Chrome", beta).
fn browser_bundle(file: &str) -> Option<(&'static str, &'static str, &'static str)> {
    BROWSER_BUNDLES
        .iter()
        .find(|b| b.0 == file)
        .map(|b| (b.1, b.2, b.3))
}

/// What a bundle's `Info.plist` says about it.
#[derive(Debug, Default, PartialEq)]
struct BundleInfo {
    /// `CFBundleShortVersionString`: "128.0.6613.120".
    version: Option<String>,
    /// `CFBundleIdentifier`: "com.google.Chrome".
    id: Option<String>,
}

/// A bundle's `Info.plist` as XML: the version and bundle id from its root
/// dict — the dicts nested in it (document types, URL types) do not get a
/// say. `None` when there is no dict at all, which is not a plist.
fn parse_bundle_info(xml: &str) -> Option<BundleInfo> {
    let (_, root) = plist_dicts(xml)
        .into_iter()
        .find(|(depth, _)| *depth == 0)?;
    let s = |k: &str| {
        plist_string(&root, k)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    Some(BundleInfo {
        version: s("CFBundleShortVersionString"),
        id: s("CFBundleIdentifier"),
    })
}

/// LaunchServices' handler list as XML: the bundle id the console user
/// opens `http` with, lowercased. Each `LSHandlers` entry is a dict naming
/// a URL scheme or a content type and the handler per role; the
/// `LSHandlerPreferredVersions` dict newer entries nest repeats the role
/// keys with "-", which is why the lookup sees each dict's own values only.
/// No entry for http means nobody chose — Safari stands in, and it is not
/// Chromium — so `None`.
fn parse_http_handler(xml: &str) -> Option<String> {
    plist_dicts(xml).iter().find_map(|(_, d)| {
        let scheme = plist_string(d, "LSHandlerURLScheme")?;
        if !scheme.trim().eq_ignore_ascii_case("http") {
            return None;
        }
        ["LSHandlerRoleAll", "LSHandlerRoleViewer"]
            .iter()
            .find_map(|role| plist_string(d, role))
            .map(|id| id.trim().to_ascii_lowercase())
            .filter(|id| !id.is_empty() && id != "-")
    })
}

/// Whether `ps -axo comm=` lists a process inside the bundle. `comm` is
/// the executable's full path, and a bundle's own binary
/// (`Contents/MacOS/…`) and its helpers (`Contents/Frameworks/…`) all start
/// with the bundle's path; the '/' after it keeps "Google Chrome.app" from
/// matching "Google Chrome.app 2".
fn bundle_running(ps: &str, bundle: &str) -> bool {
    ps.lines().any(|l| {
        l.trim()
            .strip_prefix(bundle)
            .is_some_and(|rest| rest.starts_with('/'))
    })
}

/// `dscl . -read /Users/<name> NFSHomeDirectory` → "NFSHomeDirectory:
/// /Users/name", the value.
fn parse_dscl_value(text: &str, key: &str) -> Option<String> {
    text.lines().find_map(|l| {
        let (k, v) = l.split_once(':')?;
        (k.trim() == key)
            .then(|| v.trim().to_string())
            .filter(|v| !v.is_empty())
    })
}

/// The console user's home. `/dev/console` is owned by whoever is logged
/// in at the login window — root when nobody is, and Setup Assistant's
/// `_mbsetupuser` before there is anybody — and Directory Services says
/// where their home is; `/Users/<name>` when it does not answer.
pub(super) fn console_home() -> Option<String> {
    let mut stat = Command::new("stat");
    stat.args(["-f", "%Su", "/dev/console"]);
    let name = output(stat, CONSOLE_USER)?.trim().to_string();
    if name.is_empty() || name == "root" || name.starts_with('_') {
        return None;
    }
    let mut dscl = Command::new("dscl");
    dscl.args([".", "-read", &format!("/Users/{name}"), "NFSHomeDirectory"]);
    Some(
        output(dscl, CONSOLE_USER)
            .and_then(|t| parse_dscl_value(&t, "NFSHomeDirectory"))
            .unwrap_or_else(|| format!("/Users/{name}")),
    )
}

/// A known browser bundle found in an Applications folder.
struct FoundBundle {
    /// "Google Chrome.app" — what the error lines name.
    file: String,
    kind: &'static str,
    name: &'static str,
    channel: &'static str,
    /// The bundle's full path.
    path: String,
}

/// The known browser bundles in one Applications folder. A folder that is
/// not there — the console user may have no `~/Applications` — is empty;
/// one that cannot be read is `Err`.
fn browser_bundles_in(dir: &str) -> std::io::Result<Vec<FoundBundle>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let file = entry.file_name();
        let Some(file) = file.to_str() else {
            continue;
        };
        let Some((kind, name, channel)) = browser_bundle(file) else {
            continue;
        };
        let path = format!("{dir}/{file}");
        if Path::new(&path).is_dir() {
            out.push(FoundBundle {
                file: file.to_string(),
                kind,
                name,
                channel,
                path,
            });
        }
    }
    Ok(out)
}

/// The Chromium browsers installed, and what could not be read about them.
/// Every known bundle under `/Applications` and the console user's
/// `~/Applications` is one; its `Info.plist` gives the version and bundle
/// id, one `ps` says which have a process alive, and the console user's
/// LaunchServices handler list says which one opens `http`. A bundle whose
/// Info.plist cannot be read is still listed, without a version, and is one
/// line in the errors; nothing installed is nothing to say. The error lines
/// name the bundle, never its path: a per-user path carries the user's
/// name and the errors reach the open page.
pub(super) fn read_browsers(home: Option<&str>) -> (Vec<Browser>, Vec<String>) {
    let mut errors = Vec::new();
    let mut dirs = vec![APPLICATIONS.to_string()];
    if let Some(home) = home {
        dirs.push(format!("{home}/Applications"));
    }
    // Each browser with its bundle id, which the default-browser match needs.
    let mut found: Vec<(Browser, Option<String>)> = Vec::new();
    for (i, dir) in dirs.iter().enumerate() {
        let bundles = match browser_bundles_in(dir) {
            Ok(b) => b,
            Err(e) => {
                let which = if i == 0 {
                    APPLICATIONS
                } else {
                    "~/Applications"
                };
                errors.push(format!("{which} is not readable ({e})"));
                continue;
            }
        };
        for b in bundles {
            let info = match plist_xml(&format!("{}/Contents/Info.plist", b.path), PLIST) {
                Ok(xml) => parse_bundle_info(&xml).unwrap_or_else(|| {
                    errors.push(format!("{}: Info.plist holds no dict", b.file));
                    BundleInfo::default()
                }),
                Err(e) => {
                    errors.push(format!("{}: Info.plist not readable ({e})", b.file));
                    BundleInfo::default()
                }
            };
            found.push((
                Browser {
                    name: b.name.into(),
                    kind: b.kind.into(),
                    version: info.version,
                    channel: Some(b.channel.into()),
                    path: Some(b.path),
                    running: false,
                    default_browser: false,
                },
                info.id,
            ));
        }
    }
    if found.is_empty() {
        return (Vec::new(), errors);
    }

    let mut ps = Command::new("ps");
    ps.args(["-axww", "-o", "comm="]);
    match output_or(ps, PS) {
        Ok(t) => {
            for (b, _) in &mut found {
                b.running = b.path.as_deref().is_some_and(|p| bundle_running(&t, p));
            }
        }
        Err(e) => errors.push(format!("ps failed ({e}); which browsers run is not known")),
    }

    match home {
        Some(home) => match plist_xml(&format!("{home}/{LS_HANDLERS}"), PLIST) {
            Ok(xml) => {
                if let Some(handler) = parse_http_handler(&xml) {
                    for (b, id) in &mut found {
                        b.default_browser = id
                            .as_deref()
                            .is_some_and(|id| id.eq_ignore_ascii_case(&handler));
                    }
                }
            }
            Err(e) => errors.push(format!(
                "default browser not known: the LaunchServices handler list is not readable ({e})"
            )),
        },
        None => errors.push("default browser not known: nobody is logged in at the console".into()),
    }

    found.sort_by(|a, b| a.0.kind.cmp(&b.0.kind).then(a.0.path.cmp(&b.0.path)));
    (found.into_iter().map(|(b, _)| b).collect(), errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn browser_bundles_by_name() {
        assert_eq!(
            browser_bundle("Google Chrome.app"),
            Some(("chrome", "Google Chrome", "stable"))
        );
        assert_eq!(
            browser_bundle("Google Chrome Canary.app"),
            Some(("chrome", "Google Chrome", "canary"))
        );
        assert_eq!(
            browser_bundle("Microsoft Edge Dev.app"),
            Some(("edge", "Microsoft Edge", "dev"))
        );
        assert_eq!(
            browser_bundle("Brave Browser Nightly.app"),
            Some(("brave", "Brave", "canary"))
        );
        assert_eq!(browser_bundle("Arc.app"), Some(("arc", "Arc", "stable")));
        assert_eq!(
            browser_bundle("Chromium.app"),
            Some(("chromium", "Chromium", "stable"))
        );
        assert_eq!(
            browser_bundle("Vivaldi.app"),
            Some(("vivaldi", "Vivaldi", "stable"))
        );
        assert_eq!(
            browser_bundle("Opera.app"),
            Some(("opera", "Opera", "stable"))
        );
        assert_eq!(browser_bundle("Safari.app"), None);
        assert_eq!(browser_bundle("Firefox.app"), None);
        // Every kind the contract names is one of the table's, and the
        // table's names are the ones the page shows.
        for (_, kind, _, _) in BROWSER_BUNDLES {
            assert!(matches!(
                *kind,
                "chrome" | "edge" | "brave" | "arc" | "chromium" | "vivaldi" | "opera"
            ));
        }
    }

    #[test]
    fn bundle_info_from_info_plist() {
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
            <plist version=\"1.0\">\n<dict>\n\
            \t<key>CFBundleDocumentTypes</key>\n\t<array>\n\t\t<dict>\n\
            \t\t\t<key>CFBundleTypeName</key>\n\t\t\t<string>HTML document</string>\n\
            \t\t\t<key>CFBundleIdentifier</key>\n\t\t\t<string>not.this.one</string>\n\
            \t\t</dict>\n\t</array>\n\
            \t<key>CFBundleIdentifier</key>\n\t<string>com.google.Chrome</string>\n\
            \t<key>CFBundleShortVersionString</key>\n\t<string>128.0.6613.120</string>\n\
            \t<key>CFBundleVersion</key>\n\t<string>6613.120</string>\n\
            </dict>\n</plist>\n";
        assert_eq!(
            parse_bundle_info(xml),
            Some(BundleInfo {
                version: Some("128.0.6613.120".into()),
                id: Some("com.google.Chrome".into()),
            })
        );
        assert_eq!(
            parse_bundle_info("<plist><dict><key>x</key><string>y</string></dict></plist>"),
            Some(BundleInfo::default())
        );
        assert_eq!(parse_bundle_info("bplist00\u{0}garbage"), None);
    }

    #[test]
    fn launchservices_http_handler() {
        let entry = |scheme: &str, role: &str, id: &str| {
            format!(
                "\t\t<dict>\n\t\t\t<key>LSHandlerPreferredVersions</key>\n\t\t\t<dict>\n\
                 \t\t\t\t<key>{role}</key>\n\t\t\t\t<string>-</string>\n\t\t\t</dict>\n\
                 \t\t\t<key>{role}</key>\n\t\t\t<string>{id}</string>\n\
                 \t\t\t<key>LSHandlerURLScheme</key>\n\t\t\t<string>{scheme}</string>\n\
                 \t\t</dict>\n"
            )
        };
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n\
             \t<key>LSHandlers</key>\n\t<array>\n\
             \t\t<dict>\n\t\t\t<key>LSHandlerContentType</key>\n\t\t\t<string>public.html</string>\n\
             \t\t\t<key>LSHandlerRoleAll</key>\n\t\t\t<string>com.apple.safari</string>\n\t\t</dict>\n",
        );
        xml += &entry("mailto", "LSHandlerRoleAll", "com.apple.mail");
        xml += &entry("http", "LSHandlerRoleAll", "com.microsoft.edgemac");
        xml += &entry("https", "LSHandlerRoleAll", "com.microsoft.edgemac");
        xml += "\t</array>\n</dict>\n</plist>\n";
        assert_eq!(
            parse_http_handler(&xml).as_deref(),
            Some("com.microsoft.edgemac")
        );
        // The viewer role stands in when there is no all-roles handler.
        let viewer = format!(
            "<plist><dict><key>LSHandlers</key><array>{}</array></dict></plist>",
            entry("HTTP", "LSHandlerRoleViewer", "company.thebrowser.Browser")
        );
        assert_eq!(
            parse_http_handler(&viewer).as_deref(),
            Some("company.thebrowser.browser")
        );
        // No http entry: nobody chose, and Safari is not Chromium.
        let none = format!(
            "<plist><dict><key>LSHandlers</key><array>{}</array></dict></plist>",
            entry("mailto", "LSHandlerRoleAll", "com.apple.mail")
        );
        assert_eq!(parse_http_handler(&none), None);
        assert_eq!(parse_http_handler(""), None);
    }

    #[test]
    fn running_bundles_from_ps() {
        let chrome = "/Applications/Google Chrome.app";
        let ps = "/sbin/launchd\n\
            /Applications/Google Chrome.app/Contents/MacOS/Google Chrome\n\
            /Applications/Google Chrome.app/Contents/Frameworks/Google Chrome Framework.framework/Versions/128.0.6613.120/Helpers/Google Chrome Helper (Renderer).app/Contents/MacOS/Google Chrome Helper (Renderer)\n\
            /Applications/Google Chrome.app 2/Contents/MacOS/Google Chrome\n\
            /Users/x/Applications/Brave Browser.app/Contents/MacOS/Brave Browser\n\
            kernel_task\n";
        assert!(bundle_running(ps, chrome));
        assert!(bundle_running(
            ps,
            "/Users/x/Applications/Brave Browser.app"
        ));
        assert!(!bundle_running(ps, "/Applications/Brave Browser.app"));
        assert!(!bundle_running(ps, "/Applications/Microsoft Edge.app"));
        // The stray copy is a different bundle, so it alone does not count.
        let stray = "/Applications/Google Chrome.app 2/Contents/MacOS/Google Chrome\n";
        assert!(!bundle_running(stray, chrome));
        assert!(!bundle_running("", chrome));
        assert_eq!(
            parse_dscl_value("NFSHomeDirectory: /Users/santiago\n", "NFSHomeDirectory").as_deref(),
            Some("/Users/santiago")
        );
        assert_eq!(
            parse_dscl_value("<dscl_cmd> DS Error: -14136", "NFSHomeDirectory"),
            None
        );
    }
}
