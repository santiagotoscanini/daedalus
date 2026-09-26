//! Everything installed: the `.app` bundles in the Applications folders,
//! each one's name, version and id from its `Info.plist`, tagged App
//! Store, Homebrew, Setapp or Apple's own.

use std::collections::HashSet;
use std::path::Path;
use std::time::{Duration, Instant};

use super::parse::{plist_dicts, plist_string};
use super::run::{plist_xml, Failed};
use super::{APPLICATIONS, PLIST};
use crate::telemetry::App;

/// How long the whole inventory may take: a hundred bundles, each an
/// `Info.plist` read and now and then a `plutil`, is seconds; this is for
/// a network volume that stopped answering.
const APPS_DEADLINE: Duration = Duration::from_secs(45);
/// Where Homebrew keeps the casks it installed, on Apple Silicon and Intel.
const CASKROOMS: &[&str] = &["/opt/homebrew/Caskroom", "/usr/local/Caskroom"];

/// The `.app` bundles in a folder, and — one level down — in the folders
/// that are not bundles themselves (`/Applications/Utilities`,
/// `/Applications/Setapp`). A folder that is not there is empty.
fn app_bundles_in(dir: &str) -> std::io::Result<Vec<String>> {
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(e) => return Err(e),
    };
    let mut out = Vec::new();
    for entry in entries.flatten() {
        let Some(file) = entry.file_name().to_str().map(str::to_string) else {
            continue;
        };
        let path = format!("{dir}/{file}");
        if !Path::new(&path).is_dir() {
            continue;
        }
        if file.ends_with(".app") {
            out.push(path);
        } else if !file.starts_with('.') {
            if let Ok(inner) = std::fs::read_dir(&path) {
                out.extend(inner.flatten().filter_map(|e| {
                    let f = e.file_name().to_str()?.to_string();
                    let p = format!("{path}/{f}");
                    (f.ends_with(".app") && Path::new(&p).is_dir()).then_some(p)
                }));
            }
        }
    }
    Ok(out)
}

/// What an application's `Info.plist` says about it.
#[derive(Clone, Debug, Default, PartialEq)]
struct AppInfo {
    /// `CFBundleDisplayName`, else `CFBundleName`.
    name: Option<String>,
    /// `CFBundleShortVersionString`, else `CFBundleVersion` (a build number).
    version: Option<String>,
    id: Option<String>,
}

fn parse_app_info(xml: &str) -> Option<AppInfo> {
    let (_, root) = plist_dicts(xml)
        .into_iter()
        .find(|(depth, _)| *depth == 0)?;
    let s = |k: &str| {
        plist_string(&root, k)
            .map(|v| v.trim().to_string())
            .filter(|v| !v.is_empty())
    };
    Some(AppInfo {
        name: s("CFBundleDisplayName").or_else(|| s("CFBundleName")),
        version: s("CFBundleShortVersionString").or_else(|| s("CFBundleVersion")),
        id: s("CFBundleIdentifier"),
    })
}

/// A bundle's `Info.plist` as XML: most are XML on disk and are read as a
/// file; a binary one goes through `plutil`.
fn app_plist_xml(path: &str) -> Result<String, Failed> {
    if let Ok(text) = std::fs::read_to_string(path) {
        let head = text.trim_start_matches('\u{feff}').trim_start();
        if head.starts_with("<?xml") || head.starts_with("<plist") {
            return Ok(text);
        }
    }
    plist_xml(path, PLIST)
}

/// The `.app` names Homebrew's caskrooms hold, so a bundle copied (not
/// linked) into /Applications is still known as Homebrew's.
fn caskroom_apps() -> HashSet<String> {
    let mut out = HashSet::new();
    for room in CASKROOMS {
        let Ok(casks) = std::fs::read_dir(room) else {
            continue;
        };
        for cask in casks.flatten() {
            let Ok(versions) = std::fs::read_dir(cask.path()) else {
                continue;
            };
            for v in versions.flatten() {
                let Ok(files) = std::fs::read_dir(v.path()) else {
                    continue;
                };
                out.extend(files.flatten().filter_map(|f| {
                    let name = f.file_name().to_str()?.to_string();
                    name.ends_with(".app").then_some(name)
                }));
            }
        }
    }
    out
}

/// Where a bundle came from: the App Store leaves a receipt, Homebrew
/// links or copies from its caskroom, Setapp has its own folder, Apple's
/// own carry Apple's bundle prefix, and the rest were dragged in.
fn app_source(path: &str, file: &str, id: Option<&str>, casks: &HashSet<String>) -> &'static str {
    if Path::new(&format!("{path}/Contents/_MASReceipt/receipt")).is_file() {
        return "app-store";
    }
    let linked_from_cask = std::fs::read_link(path)
        .ok()
        .is_some_and(|t| t.to_string_lossy().contains("/Caskroom/"));
    if linked_from_cask || casks.contains(file) {
        return "homebrew";
    }
    if path.starts_with("/Applications/Setapp/") {
        return "setapp";
    }
    if id.is_some_and(|i| i.starts_with("com.apple.")) {
        return "apple";
    }
    "applications"
}

/// A file's modification day, "YYYY-MM-DD".
fn modified_day(path: &str) -> Option<String> {
    let t = std::fs::metadata(path).and_then(|m| m.modified()).ok()?;
    let ago = std::time::SystemTime::now().duration_since(t).ok()?;
    let stamp = crate::state::rfc3339_ago(ago.as_secs());
    stamp.get(..10).map(str::to_string)
}

/// Everything installed under `/Applications` (and one folder down) and
/// the console user's `~/Applications`: name and version from each
/// bundle's `Info.plist`, the day the bundle was written, and where it
/// came from. Homebrew's own list is not asked for — `brew` refuses to run
/// as root, which the daemon is. The error lines name bundles, not paths,
/// as the browsers' do.
pub(super) fn read_apps(home: Option<&str>) -> (Vec<App>, Vec<String>) {
    let started = Instant::now();
    let mut errors = Vec::new();
    let mut dirs = vec![APPLICATIONS.to_string()];
    if let Some(home) = home {
        dirs.push(format!("{home}/Applications"));
    }
    let casks = caskroom_apps();
    let mut out = Vec::new();
    'dirs: for (i, dir) in dirs.iter().enumerate() {
        let bundles = match app_bundles_in(dir) {
            Ok(b) => b,
            Err(e) => {
                let which = if i == 0 {
                    APPLICATIONS
                } else {
                    "~/Applications"
                };
                errors.push(format!("apps: {which} is not readable ({e})"));
                continue;
            }
        };
        for path in bundles {
            if started.elapsed() > APPS_DEADLINE {
                errors.push(format!(
                    "apps: inventory cut short after {} bundles",
                    out.len()
                ));
                break 'dirs;
            }
            let file = path.rsplit('/').next().unwrap_or(&path).to_string();
            let info = match app_plist_xml(&format!("{path}/Contents/Info.plist")) {
                Ok(xml) => parse_app_info(&xml).unwrap_or_default(),
                Err(e) => {
                    errors.push(format!("apps: {file}: Info.plist not readable ({e})"));
                    AppInfo::default()
                }
            };
            let source = app_source(&path, &file, info.id.as_deref(), &casks);
            let name = info
                .name
                .unwrap_or_else(|| file.trim_end_matches(".app").to_string());
            out.push(App {
                kind: if file == "Steam.app" {
                    "launcher"
                } else {
                    "app"
                }
                .into(),
                version: info.version,
                publisher: None,
                installed_at: modified_day(&path),
                size_bytes: None,
                source: Some(source.into()),
                path: Some(path),
                name,
            });
        }
    }
    (crate::telemetry::tidy_apps(out), errors)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn app_info_from_info_plist() {
        let xml = "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<dict>\n\
            \t<key>CFBundleIdentifier</key>\n\t<string>com.apple.Safari</string>\n\
            \t<key>CFBundleName</key>\n\t<string>Safari</string>\n\
            \t<key>CFBundleShortVersionString</key>\n\t<string>26.0</string>\n\
            \t<key>CFBundleVersion</key>\n\t<string>21619</string>\n\
            </dict>\n</plist>\n";
        assert_eq!(
            parse_app_info(xml),
            Some(AppInfo {
                name: Some("Safari".into()),
                version: Some("26.0".into()),
                id: Some("com.apple.Safari".into()),
            })
        );
        // The display name wins over the name, the build stands in for a
        // missing marketing version.
        let xml = "<plist version=\"1.0\"><dict>\
            <key>CFBundleName</key><string>obsidian</string>\
            <key>CFBundleDisplayName</key><string>Obsidian</string>\
            <key>CFBundleVersion</key><string>1.8.10</string>\
            </dict></plist>";
        assert_eq!(
            parse_app_info(xml),
            Some(AppInfo {
                name: Some("Obsidian".into()),
                version: Some("1.8.10".into()),
                id: None,
            })
        );
        assert_eq!(parse_app_info("bplist00\u{0}garbage"), None);

        let casks: HashSet<String> = ["Obsidian.app".to_string()].into_iter().collect();
        assert_eq!(
            app_source(
                "/Applications/Obsidian.app",
                "Obsidian.app",
                Some("md.obsidian"),
                &casks
            ),
            "homebrew"
        );
        assert_eq!(
            app_source(
                "/Applications/Setapp/Bartender.app",
                "Bartender.app",
                None,
                &casks
            ),
            "setapp"
        );
        assert_eq!(
            app_source(
                "/Applications/Safari.app",
                "Safari.app",
                Some("com.apple.Safari"),
                &casks
            ),
            "apple"
        );
        assert_eq!(
            app_source(
                "/Applications/Zed.app",
                "Zed.app",
                Some("dev.zed.Zed"),
                &casks
            ),
            "applications"
        );
    }
}
