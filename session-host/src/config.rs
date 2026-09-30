//! `serve --config <file>`: where everything is. Nix writes the file
//! (nix/stacks/daedalus/session-host.nix); the README documents each key.

use std::net::SocketAddr;
use std::path::{Path, PathBuf};

use serde::Deserialize;

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    /// The TLS listeners, `address:port` each.
    pub listen: Vec<SocketAddr>,
    /// This host's own directory: `host.key` and `status.json`.
    pub state_dir: PathBuf,
    /// The approved nodes' keys (allow.rs), written by the controller.
    pub allow_list: PathBuf,
    /// The local socket agents' hooks push to (`hook`).
    pub hook_socket: PathBuf,
    /// Where the checkouts live: every `pty.open` / `exec.run` cwd and every
    /// `fs.write` parent must resolve under it.
    pub projects_root: PathBuf,
    /// The workspaces snapshot `workspaces.list` serves.
    pub workspaces: PathBuf,
    /// `hello.hookBin`: the path an agent's hook command runs.
    pub hook_bin: String,
    /// The file this was loaded from ([`Config::load`]), which the status
    /// file names (`config`): nix writes each version to a new store path,
    /// so the controller tells a running host on an old config from the
    /// installed one.
    #[serde(skip)]
    pub file: Option<PathBuf>,
}

impl Config {
    pub fn load(path: &Path) -> Result<Self, String> {
        let text = std::fs::read_to_string(path)
            .map_err(|e| format!("reading {}: {e}", path.display()))?;
        let mut config: Config =
            serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        config.check()?;
        config.file = Some(std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf()));
        Ok(config)
    }

    fn check(&self) -> Result<(), String> {
        if self.listen.is_empty() {
            return Err("listen names no address".into());
        }
        for (what, path) in [
            ("stateDir", &self.state_dir),
            ("allowList", &self.allow_list),
            ("hookSocket", &self.hook_socket),
            ("projectsRoot", &self.projects_root),
            ("workspaces", &self.workspaces),
        ] {
            if !path.is_absolute() {
                return Err(format!("{what} must be absolute"));
            }
        }
        if !Path::new(&self.hook_bin).is_absolute() {
            return Err("hookBin must be absolute".into());
        }
        Ok(())
    }

    pub fn host_key(&self) -> PathBuf {
        self.state_dir.join("host.key")
    }

    pub fn status_file(&self) -> PathBuf {
        self.state_dir.join("status.json")
    }
}
