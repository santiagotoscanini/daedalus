//! The hourly tier: what `softwareupdate` has pending and what the
//! install-history plist says was installed.

use std::process::Command;

use super::parse::plist_string;
use super::profiler::parse_size;
use super::run::{output_or, plist_xml};
use super::{QUICK, SOFTWAREUPDATE};
use crate::telemetry::{Installed, Update, Updates};

/// Where macOS logs every install, its own updates included.
const INSTALL_HISTORY: &str = "/Library/Receipts/InstallHistory.plist";

/// How many past installs `read_updates` carries.
const INSTALLED_KEPT: usize = 8;

/// `softwareupdate -l` stdout. Since Big Sur each update is two lines:
///
/// ```text
/// * Label: macOS Sonoma 14.6.1-23G93
///     Title: macOS Sonoma 14.6.1, Version: 14.6.1, Size: 1234567KiB, Recommended: YES, Action: restart,
/// ```
///
/// Catalina and before printed the label after "* " and, on the next line,
/// "title (version), 3123456K [recommended] [restart]"; both are read. "No
/// new software available." goes to stderr, so an empty stdout is no update.
fn parse_softwareupdate(text: &str) -> Vec<Update> {
    let lines: Vec<&str> = text.lines().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let head = lines[i].trim();
        i += 1;
        let Some(head) = head.strip_prefix("* ") else {
            continue;
        };
        let detail = match lines.get(i).map(|d| d.trim()) {
            Some(d) if !d.is_empty() && !d.starts_with("* ") => {
                i += 1;
                d
            }
            _ => "",
        };
        let mut u = Update::default();
        if let Some(label) = head.strip_prefix("Label:") {
            let label = label.trim();
            u.id = Some(label.to_string());
            for field in detail.split(", ") {
                let Some((k, v)) = field.split_once(':') else {
                    continue;
                };
                let v = v.trim().trim_end_matches(',').trim();
                match k.trim() {
                    "Title" => u.title = v.to_string(),
                    "Size" => u.size_bytes = parse_update_size(v),
                    "Recommended" => {
                        if v.eq_ignore_ascii_case("yes") {
                            u.severity = Some("recommended".into());
                        }
                    }
                    "Action" => u.restart = Some(v.eq_ignore_ascii_case("restart")),
                    _ => {}
                }
            }
            if u.title.is_empty() {
                u.title = label.to_string();
            }
        } else {
            let label = head.trim();
            u.id = Some(label.to_string());
            let (desc, tags) = detail.split_once(", ").unwrap_or((detail, ""));
            let title = desc.split(" (").next().unwrap_or(desc).trim();
            u.title = if title.is_empty() {
                label.to_string()
            } else {
                title.to_string()
            };
            u.size_bytes = tags.split_whitespace().next().and_then(parse_update_size);
            if tags.contains("[recommended]") {
                u.severity = Some("recommended".into());
            }
            if !tags.is_empty() {
                u.restart = Some(tags.contains("[restart]"));
            }
        }
        out.push(u);
    }
    out
}

/// "1234567KiB", "3123456K", "512MiB" → bytes; a bare number is bytes.
fn parse_update_size(s: &str) -> Option<u64> {
    let s = s.trim();
    let split = s
        .find(|c: char| !c.is_ascii_digit() && c != '.')
        .unwrap_or(s.len());
    let (num, unit) = s.split_at(split);
    if unit.trim().is_empty() {
        return num.parse().ok();
    }
    parse_size(&format!("{num} {}", unit.trim()))
}

/// `/Library/Receipts/InstallHistory.plist` as XML: an array of dicts with
/// `date`, `displayName`, `displayVersion` and `processName`, oldest first.
/// The OS's own installs are the ones `softwareupdated` or the OS Installer
/// wrote, or whose name starts with "macOS"; the last `keep` of them,
/// newest first. The version is appended when the name does not carry it.
fn parse_install_history(xml: &str, keep: usize) -> Vec<Installed> {
    let mut out: Vec<Installed> = xml
        .split("<dict>")
        .skip(1)
        .filter_map(|d| {
            let d = d.split("</dict>").next().unwrap_or(d);
            let name = plist_string(d, "displayName")?;
            let process = plist_string(d, "processName").unwrap_or_default();
            let ours = matches!(process.as_str(), "softwareupdated" | "OS Installer")
                || name.starts_with("macOS");
            if !ours || name.is_empty() {
                return None;
            }
            let version = plist_string(d, "displayVersion").unwrap_or_default();
            let title = if version.is_empty() || name.contains(&version) {
                name
            } else {
                format!("{name} {version}")
            };
            Some(Installed {
                title,
                at: plist_string(d, "date").filter(|s| !s.is_empty()),
            })
        })
        .collect();
    let mut out = out.split_off(out.len().saturating_sub(keep));
    out.reverse();
    out
}

/// What the OS's updater says, hourly on its own thread. The pending list
/// is `softwareupdate -l --no-scan` — the OS's own last scan, so no
/// network and a second; when that is refused, one real scan, which asks
/// Apple's servers and can take a minute. The installed list is the
/// receipts history, read through `plutil -convert xml1` (its `json`
/// output refuses the `<date>` values this file is full of) or straight
/// from the file, which is XML on disk anyway. macOS keeps no "restart
/// pending" flag a tool can read, so that stays `None`.
pub fn read_updates() -> Updates {
    let mut u = Updates {
        checked_at: Some(crate::state::now_rfc3339()),
        ..Default::default()
    };
    let mut cached = Command::new("softwareupdate");
    cached.args(["-l", "--no-scan"]);
    let listed = output_or(cached, SOFTWAREUPDATE).or_else(|_| {
        let mut scan = Command::new("softwareupdate");
        scan.arg("-l");
        output_or(scan, SOFTWAREUPDATE)
    });
    match listed {
        Ok(text) => u.pending = parse_softwareupdate(&text),
        Err(e) => u.error = Some(format!("softwareupdate -l failed ({e})")),
    }
    match plist_xml(INSTALL_HISTORY, QUICK) {
        Ok(xml) => u.installed = parse_install_history(&xml, INSTALLED_KEPT),
        Err(e) => {
            let line = format!("install history not readable ({e})");
            u.error = Some(match u.error.take() {
                Some(first) => format!("{first}; {line}"),
                None => line,
            });
        }
    }
    u
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn softwareupdate_modern_and_catalina() {
        let modern = "Software Update Tool\n\nFinding available software\n\
            Software Update found the following new or updated software:\n\
            * Label: macOS Sonoma 14.6.1-23G93\n\
            \tTitle: macOS Sonoma 14.6.1, Version: 14.6.1, Size: 1234567KiB, Recommended: YES, Action: restart,\n\
            * Label: Command Line Tools for Xcode-15.3\n\
            \tTitle: Command Line Tools for Xcode, Version: 15.3, Size: 728512KiB, Recommended: YES,\n";
        let u = parse_softwareupdate(modern);
        assert_eq!(u.len(), 2);
        assert_eq!(u[0].title, "macOS Sonoma 14.6.1");
        assert_eq!(u[0].id.as_deref(), Some("macOS Sonoma 14.6.1-23G93"));
        assert_eq!(u[0].size_bytes, Some(1234567 * 1024));
        assert_eq!(u[0].severity.as_deref(), Some("recommended"));
        assert_eq!(u[0].restart, Some(true));
        assert_eq!(u[1].title, "Command Line Tools for Xcode");
        assert_eq!(u[1].size_bytes, Some(728512 * 1024));
        assert_eq!(u[1].restart, None);
        let old = "Software Update found the following new or updated software:\n\
            \x20  * macOS Catalina 10.15.7 Update-10.15.7\n\
            \tmacOS Catalina 10.15.7 Update (10.15.7), 3123456K [recommended] [restart]\n";
        let u = parse_softwareupdate(old);
        assert_eq!(u.len(), 1);
        assert_eq!(u[0].title, "macOS Catalina 10.15.7 Update");
        assert_eq!(
            u[0].id.as_deref(),
            Some("macOS Catalina 10.15.7 Update-10.15.7")
        );
        assert_eq!(u[0].size_bytes, Some(3123456 * 1024));
        assert_eq!(u[0].severity.as_deref(), Some("recommended"));
        assert_eq!(u[0].restart, Some(true));
        assert!(parse_softwareupdate("Software Update Tool\n").is_empty());
        assert!(parse_softwareupdate("").is_empty());
        assert_eq!(parse_update_size("512MiB"), Some(512 << 20));
        assert_eq!(parse_update_size("4096"), Some(4096));
        assert_eq!(parse_update_size("lots"), None);
    }

    #[test]
    fn install_history_last_os_installs_newest_first() {
        let entry = |date: &str, name: &str, version: &str, process: &str| {
            format!(
                "<dict>\n\t<key>date</key>\n\t<date>{date}</date>\n\t<key>displayName</key>\n\t<string>{name}</string>\n\
                 \t<key>displayVersion</key>\n\t<string>{version}</string>\n\t<key>packageIdentifiers</key>\n\
                 \t<array>\n\t\t<string>com.apple.pkg.x</string>\n\t</array>\n\
                 \t<key>processName</key>\n\t<string>{process}</string>\n</dict>\n"
            )
        };
        let mut xml = String::from(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\">\n<array>\n",
        );
        xml += &entry("2024-01-01T00:00:00Z", "Google Chrome", "120", "Installer");
        for i in 1..=9 {
            xml += &entry(
                &format!("2025-0{i}-01T00:00:00Z"),
                "macOS Sonoma",
                &format!("14.{i}"),
                "softwareupdated",
            );
        }
        xml += &entry(
            "2025-10-01T00:00:00Z",
            "macOS Sequoia 15.0",
            "15.0",
            "OS Installer",
        );
        xml += &entry(
            "2025-11-01T00:00:00Z",
            "Rosetta &amp; Friends",
            "",
            "softwareupdated",
        );
        xml += "</array>\n</plist>\n";
        let h = parse_install_history(&xml, 8);
        assert_eq!(h.len(), 8);
        assert_eq!(h[0].title, "Rosetta & Friends");
        assert_eq!(h[0].at.as_deref(), Some("2025-11-01T00:00:00Z"));
        assert_eq!(h[1].title, "macOS Sequoia 15.0");
        assert_eq!(h[2].title, "macOS Sonoma 14.9");
        assert_eq!(h[7].title, "macOS Sonoma 14.4");
        assert!(h.iter().all(|i| !i.title.contains("Chrome")));
        assert!(parse_install_history("<plist/>", 8).is_empty());
        assert_eq!(
            plist_string("<key>a</key><string/>", "a").as_deref(),
            Some("")
        );
    }
}
