//! Small helpers the agent's threads share.

use std::path::Path;
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

/// The service's stop, and the updater's "check now": one token every
/// worker holds a clone of. Waiting on it is a condition variable, not a
/// poll — a stop reaches every waiter at once.
#[derive(Clone, Default)]
pub struct Shutdown(Arc<(Mutex<Flags>, Condvar)>);

#[derive(Default)]
struct Flags {
    stopped: bool,
    /// Bumped by `nudge`; a waiter that asked for nudges wakes when it moves.
    nudges: u64,
}

impl Shutdown {
    pub fn new() -> Self {
        Self::default()
    }

    /// Stop: every wait returns true from now on.
    pub fn stop(&self) {
        let (lock, cv) = &*self.0;
        lock.lock_ok().stopped = true;
        cv.notify_all();
    }

    pub fn is_stopped(&self) -> bool {
        self.0 .0.lock_ok().stopped
    }

    /// Wake the waiters that asked for nudges (`wait_nudged`) without
    /// stopping anyone.
    pub fn nudge(&self) {
        let (lock, cv) = &*self.0;
        lock.lock_ok().nudges += 1;
        cv.notify_all();
    }

    /// How many nudges so far: what `wait_nudged` compares against, taken
    /// before the caller looks at what a nudge asks for, so none is missed.
    pub fn nudges(&self) -> u64 {
        self.0 .0.lock_ok().nudges
    }

    /// Wait `total` or until stopped; true when stopped.
    pub fn wait(&self, total: Duration) -> bool {
        self.wait_for(total, None)
    }

    /// The same, also cut short by a nudge after `since` (`nudges`).
    pub fn wait_nudged(&self, since: u64, total: Duration) -> bool {
        self.wait_for(total, Some(since))
    }

    fn wait_for(&self, total: Duration, since: Option<u64>) -> bool {
        let until = std::time::Instant::now() + total;
        let (lock, cv) = &*self.0;
        let mut f = lock.lock_ok();
        loop {
            if f.stopped {
                return true;
            }
            if since.is_some_and(|s| f.nudges != s) {
                return false;
            }
            let left = until.saturating_duration_since(std::time::Instant::now());
            if left.is_zero() {
                return false;
            }
            f = cv
                .wait_timeout(f, left)
                .unwrap_or_else(|p| p.into_inner())
                .0;
        }
    }
}

/// Start a named worker thread with a clone of the shared state and of the
/// stop, the way every worker of the service starts.
pub fn spawn_worker<S: Send + Sync + ?Sized + 'static>(
    name: &str,
    shared: &Arc<S>,
    stop: &Shutdown,
    work: impl FnOnce(Arc<S>, Shutdown) + Send + 'static,
) -> std::io::Result<std::thread::JoinHandle<()>> {
    let (shared, stop) = (Arc::clone(shared), stop.clone());
    std::thread::Builder::new()
        .name(name.into())
        .spawn(move || work(shared, stop))
}

/// Something bound now or later — a socket, a port — that must not stop
/// the service when it cannot be had: `bind` is tried at once and then
/// every `every` until it gives one (it logs its own failures), which is
/// held until this is dropped.
pub struct Rebinding<T> {
    held: Arc<Mutex<Option<T>>>,
    since: Arc<Mutex<Option<std::time::Instant>>>,
    stop: Shutdown,
}

impl<T: Send + 'static> Rebinding<T> {
    pub fn start(
        name: &str,
        every: Duration,
        mut bind: impl FnMut() -> Option<T> + Send + 'static,
    ) -> Self {
        let me = Self {
            held: Arc::new(Mutex::new(None)),
            since: Arc::new(Mutex::new(None)),
            stop: Shutdown::new(),
        };
        let (held, since, stop) = (Arc::clone(&me.held), Arc::clone(&me.since), me.stop.clone());
        let mut take = move || match bind() {
            Some(t) => {
                *held.lock_ok() = Some(t);
                *since.lock_ok() = Some(std::time::Instant::now());
                true
            }
            None => false,
        };
        if !take() {
            let _ = std::thread::Builder::new()
                .name(name.into())
                .spawn(move || {
                    while !stop.wait(every) {
                        if take() {
                            return;
                        }
                    }
                });
        }
        me
    }

    /// How long it has been held; None while it is not.
    pub fn up_for(&self) -> Option<Duration> {
        self.since.lock_ok().map(|t| t.elapsed())
    }
}

impl<T> Drop for Rebinding<T> {
    fn drop(&mut self) {
        self.stop.stop();
        drop(self.held.lock_ok().take());
    }
}

/// A mutex's guard whether or not a thread panicked holding it: every
/// lock in the agent guards plain data that stays consistent between
/// statements, so a poisoned one is taken as it is rather than spreading
/// the panic.
pub trait LockExt<T> {
    fn lock_ok(&self) -> std::sync::MutexGuard<'_, T>;
}

impl<T> LockExt<T> for std::sync::Mutex<T> {
    fn lock_ok(&self) -> std::sync::MutexGuard<'_, T> {
        self.lock().unwrap_or_else(|p| p.into_inner())
    }
}

/// Who may read a file `write_atomic` writes.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Access {
    /// Whatever the directory and the umask give.
    Inherit,
    /// This unix mode, whatever the umask took off; Windows inherits the
    /// directory's ACL.
    Mode(u32),
    /// The owner alone: 0600 on unix; on Windows an explicit, protected
    /// ACL — SYSTEM and Administrators, nothing inherited — set as the
    /// file is created, never after (`os::create_private`).
    Private,
}

/// Replace `path` with `bytes` so a reader — or a crash, or a power cut —
/// sees the old file or the new one, never a torn one: written to a
/// temporary file beside it that did not exist before (so a planted
/// symlink or a file someone else opened is never written through),
/// flushed to disk, renamed over it, and on unix the directory flushed
/// too. Every file the agent writes goes through here.
pub fn write_atomic(path: &Path, bytes: &[u8], access: Access) -> std::io::Result<()> {
    use std::io::Write;
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .unwrap_or(Path::new("."));
    let name = path
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let tmp = dir.join(format!(".{name}.{}.tmp", std::process::id()));
    // One of ours from a run that died mid-write; `create_new` below
    // refuses whatever is there, ours or not.
    let _ = std::fs::remove_file(&tmp);
    let written = (|| {
        let mut f = match access {
            Access::Private => crate::os::create_private(&tmp)?,
            Access::Inherit | Access::Mode(_) => {
                let mut opts = std::fs::OpenOptions::new();
                opts.write(true).create_new(true);
                #[cfg(unix)]
                if let Access::Mode(m) = access {
                    use std::os::unix::fs::OpenOptionsExt;
                    opts.mode(m);
                }
                opts.open(&tmp)?
            }
        };
        f.write_all(bytes)?;
        #[cfg(unix)]
        if let Access::Mode(m) = access {
            use std::os::unix::fs::PermissionsExt;
            f.set_permissions(std::fs::Permissions::from_mode(m))?;
        }
        f.sync_all()?;
        drop(f);
        std::fs::rename(&tmp, path)
    })();
    if written.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    written?;
    #[cfg(unix)]
    if let Ok(d) = std::fs::File::open(dir) {
        let _ = d.sync_all();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stop_reaches_a_waiter_at_once_and_a_nudge_only_those_who_asked() {
        let stop = Shutdown::new();
        assert!(!stop.wait(Duration::ZERO));
        let waiter = {
            let stop = stop.clone();
            std::thread::spawn(move || {
                let t = std::time::Instant::now();
                (stop.wait(Duration::from_secs(30)), t.elapsed())
            })
        };
        let nudged = {
            let stop = stop.clone();
            std::thread::spawn(move || stop.wait_nudged(stop.nudges(), Duration::from_secs(30)))
        };
        std::thread::sleep(Duration::from_millis(50));
        stop.nudge();
        assert!(!nudged.join().unwrap(), "a nudge is not a stop");
        std::thread::sleep(Duration::from_millis(50));
        assert!(!waiter.is_finished(), "a plain wait ignores nudges");
        stop.stop();
        let (stopped, took) = waiter.join().unwrap();
        assert!(stopped && took < Duration::from_secs(1), "{took:?}");
        assert!(stop.is_stopped() && stop.wait(Duration::from_secs(30)));
    }

    #[test]
    fn an_atomic_write_replaces_the_file_whole_and_leaves_no_temporary() {
        let dir = std::env::temp_dir().join(format!("daedalus-atomic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let p = dir.join("state.json");
        write_atomic(&p, b"one", Access::Inherit).unwrap();
        write_atomic(&p, b"two", Access::Private).unwrap();
        assert_eq!(std::fs::read(&p).unwrap(), b"two");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let m = std::fs::metadata(&p).unwrap().permissions().mode() & 0o777;
            assert_eq!(m, 0o600);
        }
        assert_eq!(std::fs::read_dir(&dir).unwrap().count(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A symlink planted where a private file goes is replaced, never
    /// written through, and the file is 0600 whatever the umask.
    #[cfg(unix)]
    #[test]
    fn a_private_write_never_follows_a_planted_link() {
        use std::os::unix::fs::PermissionsExt;
        let dir = std::env::temp_dir().join(format!("daedalus-plant-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let victim = dir.join("victim");
        std::fs::write(&victim, b"untouched").unwrap();
        let key = dir.join("identity.key");
        std::os::unix::fs::symlink(&victim, &key).unwrap();
        write_atomic(&key, b"secret", Access::Private).unwrap();
        assert_eq!(std::fs::read(&victim).unwrap(), b"untouched");
        let m = std::fs::symlink_metadata(&key).unwrap();
        assert!(m.file_type().is_file());
        assert_eq!(m.permissions().mode() & 0o777, 0o600);
        // A key others could read is refused.
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o644)).unwrap();
        assert!(crate::os::ensure_private(&key).is_err());
        std::fs::set_permissions(&key, std::fs::Permissions::from_mode(0o600)).unwrap();
        assert!(crate::os::ensure_private(&key).is_ok());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
