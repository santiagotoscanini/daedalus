//! Where the server runs.
//!
//! `claude remote-control` refuses the home directory: home-directory trust
//! is never saved, so it has to run in a project directory the user has
//! trusted once (the dialog on first `claude` there). The box runs its own in
//! the configuration checkout; a node has no such fixed place, so the tray
//! picks one: the directory the policy or the config names, or else the
//! trusted project the user ran Claude in most recently — the CLI records
//! both facts per project in `~/.claude.json`.

use std::path::{Path, PathBuf};

use super::profile::home_dir;

/// `~/.claude.json`, the CLI's own record of projects and trust.
fn cli_config_path() -> Option<PathBuf> {
    if let Some(d) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Some(PathBuf::from(d).join(".claude.json"));
    }
    home_dir().map(|h| h.join(".claude.json"))
}

/// The trusted project directory used most recently, if any exists.
pub fn most_recent_trusted_project() -> Option<PathBuf> {
    let text = std::fs::read_to_string(cli_config_path()?).ok()?;
    trusted_project_in(&text, home_dir().as_deref(), Path::is_dir)
}

/// The pure half: the most recently started trusted project in the CLI's
/// config text, skipping the home directory and anything `exists` denies.
fn trusted_project_in(
    config: &str,
    home: Option<&Path>,
    exists: impl Fn(&Path) -> bool,
) -> Option<PathBuf> {
    let v: serde_json::Value = serde_json::from_str(config).ok()?;
    v.get("projects")?
        .as_object()?
        .iter()
        .filter(|(_, p)| p.get("hasTrustDialogAccepted").and_then(|t| t.as_bool()) == Some(true))
        .map(|(dir, p)| {
            let last = ["lastStartTime", "lastSessionModified"]
                .iter()
                .find_map(|k| p.get(k).and_then(|t| t.as_str()))
                .unwrap_or_default()
                .to_string();
            (PathBuf::from(dir), last)
        })
        .filter(|(dir, _)| home != Some(dir.as_path()) && exists(dir))
        .max_by(|a, b| a.1.cmp(&b.1))
        .map(|(dir, _)| dir)
}

/// Where the server should run: the named directory when it exists, else the
/// most recent trusted project, else the home directory (which will not
/// work, and the server's own message says why).
pub fn pick_workdir(named: Option<&str>) -> (PathBuf, &'static str) {
    if let Some(d) = named.map(str::trim).filter(|d| !d.is_empty()) {
        let p = PathBuf::from(d);
        if p.is_dir() {
            return (p, "named");
        }
    }
    if let Some(p) = most_recent_trusted_project() {
        return (p, "most recent trusted project");
    }
    (
        home_dir().unwrap_or_else(|| PathBuf::from(".")),
        "home (no trusted project found)",
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn picks_the_latest_trusted_project_and_never_home() {
        let cfg = r#"{"projects":{
            "/home/u":{"hasTrustDialogAccepted":true,"lastStartTime":"2026-09-22T10:00:00Z"},
            "/home/u/old":{"hasTrustDialogAccepted":true,"lastStartTime":"2026-09-01T00:00:00Z"},
            "/home/u/new":{"hasTrustDialogAccepted":true,"lastStartTime":"2026-09-20T00:00:00Z"},
            "/home/u/gone":{"hasTrustDialogAccepted":true,"lastStartTime":"2026-09-21T00:00:00Z"},
            "/home/u/untrusted":{"hasTrustDialogAccepted":false,"lastStartTime":"2026-09-22T00:00:00Z"}
        }}"#;
        let exists = |p: &Path| p != Path::new("/home/u/gone");
        assert_eq!(
            trusted_project_in(cfg, Some(Path::new("/home/u")), exists),
            Some(PathBuf::from("/home/u/new"))
        );
        assert_eq!(trusted_project_in("{}", None, |_| true), None);
        assert_eq!(trusted_project_in("not json", None, |_| true), None);
    }
}
