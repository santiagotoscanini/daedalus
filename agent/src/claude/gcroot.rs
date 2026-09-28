//! The `claude` a job runs, kept from the nix garbage collector while the
//! job runs — where that `claude` is a nix store path at all (the box, and
//! any machine whose Claude Code nix installed; elsewhere nothing here
//! does anything).
//!
//! A rebuild can leave the server or a resumed session running a `claude`
//! no generation names any more; a collection would then delete the files
//! under a running process. So when the session starts a job it pins that
//! store path: a symlink `gcroots/<job name>` in the session's state
//! directory, registered as an indirect root with `nix-store --add-root`,
//! which the operator's own user may do (the daemon records it under
//! `/nix/var/nix/gcroots/auto`; the per-user directory there is root's and
//! need not exist). A link whose job is gone is removed (`sweep`), and the
//! next collection forgets the root.

use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::Duration;

/// The store path — `/nix/store/<hash>-<name>` — a path lies in, if any.
pub fn store_path_of(p: &Path) -> Option<PathBuf> {
    let mut c = p.components();
    let ok = matches!(c.next(), Some(Component::RootDir))
        && c.next() == Some(Component::Normal("nix".as_ref()))
        && c.next() == Some(Component::Normal("store".as_ref()));
    let Some(Component::Normal(entry)) = c.next() else {
        return None;
    };
    let name = entry.to_str()?;
    // `<32 base-32 characters>-<name>`.
    let valid = name.len() > 33
        && name.as_bytes()[32] == b'-'
        && name[..32]
            .bytes()
            .all(|b| b.is_ascii_digit() || b.is_ascii_lowercase());
    (ok && valid).then(|| Path::new("/nix/store").join(name))
}

/// The store path to pin for a `claude`: the one the path as found lies
/// in (a wrapper keeps what it wraps alive), else the one it resolves to.
pub fn store_path_for(cli: &Path) -> Option<PathBuf> {
    store_path_of(cli).or_else(|| store_path_of(&std::fs::canonicalize(cli).ok()?))
}

fn nix_store() -> Option<PathBuf> {
    crate::exec::locate("nix-store").or_else(|| {
        let p = PathBuf::from("/nix/var/nix/profiles/default/bin/nix-store");
        p.is_file().then_some(p)
    })
}

/// Pin the store path `cli` lies in for the job `name`; a no-op where it
/// lies in none. Failures are logged, never fatal: a job runs unpinned
/// rather than not at all.
pub fn pin(roots: &Path, name: &str, cli: &Path) {
    let Some(store) = store_path_for(cli) else {
        return;
    };
    let link = roots.join(name);
    if std::fs::read_link(&link).is_ok_and(|t| t == store) {
        return;
    }
    let Some(tool) = nix_store() else {
        tracing::warn!(
            job = name,
            "no nix-store on this machine; the running claude is not pinned"
        );
        return;
    };
    if let Err(e) = std::fs::create_dir_all(roots) {
        tracing::warn!(dir = %roots.display(), error = %e, "the gcroots directory was not made");
        return;
    }
    let _ = std::fs::remove_file(&link);
    let mut cmd = Command::new(tool);
    cmd.arg("--add-root")
        .arg(&link)
        .arg("--realise")
        .arg(&store);
    match crate::exec::both(cmd, Duration::from_secs(30)) {
        Some(r) if r.ok => {
            tracing::info!(job = name, store = %store.display(), "pinned the claude this job runs")
        }
        Some(r) => {
            tracing::warn!(job = name, output = %r.output.trim(), "nix-store --add-root failed")
        }
        None => tracing::warn!(job = name, "nix-store --add-root did not finish"),
    }
}

/// Remove the pins whose job `running` says is gone.
pub fn sweep(roots: &Path, running: impl Fn(&str) -> bool) {
    let Ok(entries) = std::fs::read_dir(roots) else {
        return;
    };
    for e in entries.flatten() {
        let name = e.file_name().to_string_lossy().into_owned();
        let is_link = e.file_type().is_ok_and(|t| t.is_symlink());
        if is_link && !running(&name) {
            match std::fs::remove_file(e.path()) {
                Ok(()) => tracing::info!(job = %name, "unpinned the claude of a job that is gone"),
                Err(err) => tracing::warn!(job = %name, error = %err, "a gcroot was not removed"),
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_store_path_is_the_entry_under_nix_store() {
        let h = "406b184jzwfcj0gwscggw3p72l65qdyp";
        assert_eq!(
            store_path_of(Path::new(&format!(
                "/nix/store/{h}-claude-code-2.1.281/bin/claude"
            ))),
            Some(PathBuf::from(format!("/nix/store/{h}-claude-code-2.1.281")))
        );
        for no in [
            "/usr/bin/claude",
            "/nix/store",
            "/nix/store/short-name/bin/claude",
            "nix/store/406b184jzwfcj0gwscggw3p72l65qdyp-x/bin/c",
            "/home/nix/store/406b184jzwfcj0gwscggw3p72l65qdyp-x/bin/c",
        ] {
            assert_eq!(store_path_of(Path::new(no)), None, "{no}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn a_sweep_removes_the_links_of_jobs_that_are_gone() {
        let dir = std::env::temp_dir().join(format!("daedalus-gcroots-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        for n in ["keep", "gone"] {
            std::os::unix::fs::symlink("/nix/store/none", dir.join(n)).unwrap();
        }
        std::fs::write(dir.join("not-a-link"), "").unwrap();
        sweep(&dir, |n| n == "keep");
        let mut left: Vec<String> = std::fs::read_dir(&dir)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().into_owned())
            .collect();
        left.sort();
        assert_eq!(left, ["keep", "not-a-link"]);
        // A path outside the store pins nothing and makes no directory.
        pin(&dir.join("sub"), "x", Path::new("/usr/bin/claude"));
        assert!(!dir.join("sub").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
