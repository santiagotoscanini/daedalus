//! What macOS and Linux share: the machine's name from `gethostname`, the
//! identity file's 0600 posture, the executable bit, the Ctrl-C / SIGTERM
//! relay, processes in groups of their own, and the two unix sockets — the
//! controller's API (api/) and the agent's local door (local.rs), one
//! server core with a gate each. Each OS module re-exports the parts it
//! uses.

use std::path::Path;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use crate::util::LockExt;
use anyhow::{Context, Result};

/// `gethostname`, without a DHCP or `.local` suffix; None when it fails or
/// is empty (launchd hands a daemon no HOSTNAME, so this is the fallback).
pub fn short_hostname() -> Option<String> {
    let mut buf = [0u8; 256];
    // SAFETY: a buffer of the stated size; the name is NUL-terminated.
    let rc = unsafe { libc::gethostname(buf.as_mut_ptr().cast(), buf.len()) };
    if rc != 0 {
        return None;
    }
    let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
    let name = String::from_utf8_lossy(&buf[..end]).trim().to_string();
    name.split('.')
        .next()
        .filter(|s| !s.is_empty())
        .map(str::to_string)
}

/// The seed is kept as it is: the file's mode is the protection, the
/// ordinary SSH-key posture.
pub fn seal(seed: &[u8]) -> Result<Vec<u8>> {
    Ok(seed.to_vec())
}

pub fn unseal(sealed: &[u8]) -> Result<Vec<u8>> {
    Ok(sealed.to_vec())
}

/// A new file only its owner can read or write: created 0600 (whatever the
/// umask), never through a symlink, never over anything already there
/// (util.rs `write_atomic`).
pub fn create_private(path: &Path) -> std::io::Result<std::fs::File> {
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    let f = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)?;
    f.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    Ok(f)
}

/// A secret file is its owner's alone: refused when group or others may
/// read or write it (a key that was readable is no longer a secret), and
/// when it is not a regular file.
pub fn ensure_private(path: &Path) -> Result<()> {
    use std::os::unix::fs::MetadataExt;
    let m =
        std::fs::symlink_metadata(path).with_context(|| format!("reading {}", path.display()))?;
    if !m.file_type().is_file() {
        anyhow::bail!("{} is not a regular file; refusing it", path.display());
    }
    if m.mode() & 0o077 != 0 {
        anyhow::bail!(
            "{} is readable or writable beyond its owner (mode {:o}); a key others could read is \
             not a secret — refusing it (make it 0600 if it never left this machine, or delete it \
             for a new identity)",
            path.display(),
            m.mode() & 0o777
        );
    }
    Ok(())
}

/// How config.toml is written: readable by the session, which runs as the
/// user; it holds no secret.
pub const CONFIG_ACCESS: crate::util::Access = crate::util::Access::Mode(0o644);

/// Mode 0755: a downloaded binary is not executable until it is said to be.
pub fn mark_executable(path: &Path) -> std::io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755))
}

/// No console to hide on unix.
pub fn hide_console(cmd: &mut Command) -> &mut Command {
    cmd
}

/// Signal 0 delivers nothing and says whether the pid exists (EPERM means
/// it does, owned by someone else).
pub fn pid_alive(pid: u32) -> bool {
    // SAFETY: kill with signal 0 has no effect on the target.
    let rc = unsafe { libc::kill(pid as libc::pid_t, 0) };
    rc == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM)
}

/// Run the child in a process group of its own, so `stop_process_tree` can
/// reach what it spawns and not only the child.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn own_process_group(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

/// SIGTERM to the group the child leads (`own_process_group`), then a
/// moment — two seconds — to leave on its own. The caller kills and reaps
/// whatever is left.
#[cfg_attr(target_os = "macos", allow(dead_code))]
pub fn stop_process_tree(child: &mut Child) {
    let pid = child.id();
    // SAFETY: a signal to the group the child leads; nothing else is in it.
    unsafe {
        let _ = libc::kill(-(pid as libc::pid_t), libc::SIGTERM);
    }
    for _ in 0..20 {
        if matches!(child.try_wait(), Ok(Some(_))) {
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// A command `exec` runs leads a process group of its own, so `kill_tree`
/// ends what it started too (audit D19).
pub fn isolate(cmd: &mut Command) {
    use std::os::unix::process::CommandExt;
    cmd.process_group(0);
}

/// What `kill_tree` ends besides the child: here the process group
/// `isolate` made, which needs nothing kept.
pub struct Tree;

pub fn contain(child: &Child) -> Tree {
    let _ = child;
    Tree
}

/// SIGKILL to the group the child leads (`isolate`), and to the child: a
/// grandchild holding the output pipes open goes with it.
pub fn kill_tree(child: &mut Child, tree: &Tree) {
    let _ = tree;
    let pid = child.id() as libc::pid_t;
    // SAFETY: a signal to the group the child leads.
    unsafe {
        let _ = libc::kill(-pid, libc::SIGKILL);
    }
    let _ = child.kill();
}

/// SIGINT or SIGTERM runs `f`, once. A C handler cannot carry a closure; a
/// flag and a relay thread can — the thread looks every 200 ms. What `serve`
/// uses in a terminal, and what `run` uses under launchd, which sends
/// SIGTERM on `bootout` and at shutdown.
pub fn on_interrupt<F: Fn() + Send + Sync + 'static>(f: F) {
    static HIT: AtomicBool = AtomicBool::new(false);
    extern "C" fn on_signal(_: libc::c_int) {
        HIT.store(true, Ordering::Relaxed);
    }
    // SAFETY: the handler only stores to an atomic.
    unsafe {
        libc::signal(libc::SIGINT, on_signal as *const () as libc::sighandler_t);
        libc::signal(libc::SIGTERM, on_signal as *const () as libc::sighandler_t);
    }
    std::thread::spawn(move || loop {
        if HIT.load(Ordering::Relaxed) {
            f();
            return;
        }
        std::thread::sleep(Duration::from_millis(200));
    });
}

/// `claude`, on every unix.
pub const CLAUDE_CLI_NAMES: &[&str] = &["claude"];

/// The resumed session's terminal holder is Windows' (os/windows/holder.rs);
/// on unix `script` is the terminal, so the verb refuses.
pub fn claude_holder(args: &[String]) -> anyhow::Result<i32> {
    let _ = args;
    anyhow::bail!(
        "`claude-holder` is the Windows session's terminal; here a resumed session runs under `script`"
    )
}

/// CLOCK_MONOTONIC in microseconds: the clock systemd's `…Monotonic`
/// timestamps are on.
pub fn monotonic_usec() -> Option<u64> {
    let mut ts = libc::timespec {
        tv_sec: 0,
        tv_nsec: 0,
    };
    // SAFETY: a valid out-struct for a clock every unix has.
    if unsafe { libc::clock_gettime(libc::CLOCK_MONOTONIC, &mut ts) } != 0 {
        return None;
    }
    Some(ts.tv_sec as u64 * 1_000_000 + ts.tv_nsec as u64 / 1_000)
}

/// An exclusive lock on `path` (created if absent), held while the returned
/// file is open; None when another process holds it. The file is the
/// owner's alone (0600, never through a symlink): `flock` works on a
/// read-only descriptor, so a lock file others can open is one any local
/// user can hold to keep the agent from starting (audit D6).
pub fn lock_exclusive(path: &Path) -> Option<std::fs::File> {
    use std::os::fd::AsRawFd;
    use std::os::unix::fs::OpenOptionsExt;
    let f = std::fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(path)
        .ok()?;
    // SAFETY: flock on a descriptor this function owns.
    let rc = unsafe { libc::flock(f.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    (rc == 0).then_some(f)
}

// ── the local sockets: the API's and the agent's own ───────────────────────

/// The API's socket (api/), served by a thread until this is dropped,
/// which stops accepting and removes the socket.
pub struct LocalSocket {
    path: std::path::PathBuf,
    /// The socket file this process made, so a drop never removes one a
    /// later instance put in its place.
    ino: u64,
    stop: std::sync::Arc<AtomicBool>,
    /// Shared with the accept thread; the fd closes when both let go.
    listener: std::sync::Arc<std::os::unix::net::UnixListener>,
}

impl Drop for LocalSocket {
    /// Never waits: the accept thread is woken — `shutdown` on the
    /// listener (Linux) and a non-blocking connection of our own (where the
    /// file is still there) — and leaves on its own. A drop that joined it
    /// would hang the agent's stop whenever neither wake reached it.
    fn drop(&mut self) {
        use std::os::fd::AsRawFd;
        use std::os::unix::fs::MetadataExt;
        self.stop.store(true, Ordering::Relaxed);
        // SAFETY: shutdown on a socket this struct keeps open.
        unsafe {
            libc::shutdown(self.listener.as_raw_fd(), libc::SHUT_RDWR);
        }
        if std::fs::symlink_metadata(&self.path).is_ok_and(|m| m.ino() == self.ino) {
            let _ = probe(&self.path);
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

/// The uid and the pid on the other end of a unix socket, as the kernel
/// states them.
#[cfg(target_os = "linux")]
fn peer_cred(s: &std::os::unix::net::UnixStream) -> (Option<u32>, Option<u32>) {
    use std::os::fd::AsRawFd;
    let mut cred = libc::ucred {
        pid: 0,
        uid: 0,
        gid: 0,
    };
    let mut len = std::mem::size_of::<libc::ucred>() as libc::socklen_t;
    // SAFETY: SO_PEERCRED fills a ucred of the stated size on this socket.
    let rc = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_SOCKET,
            libc::SO_PEERCRED,
            (&mut cred as *mut libc::ucred).cast(),
            &mut len,
        )
    };
    if rc == 0 && len as usize == std::mem::size_of::<libc::ucred>() {
        (
            Some(cred.uid),
            u32::try_from(cred.pid).ok().filter(|p| *p != 0),
        )
    } else {
        (None, None)
    }
}

/// The uid and the pid on the other end of a unix socket, as the kernel
/// states them.
#[cfg(target_os = "macos")]
fn peer_cred(s: &std::os::unix::net::UnixStream) -> (Option<u32>, Option<u32>) {
    use std::os::fd::AsRawFd;
    let (mut uid, mut gid) = (0, 0);
    // SAFETY: getpeereid writes two ids for a connected unix socket.
    let rc = unsafe { libc::getpeereid(s.as_raw_fd(), &mut uid, &mut gid) };
    let mut pid: libc::pid_t = 0;
    let mut len = std::mem::size_of::<libc::pid_t>() as libc::socklen_t;
    // SAFETY: LOCAL_PEERPID fills a pid_t of the stated size on this socket.
    let got = unsafe {
        libc::getsockopt(
            s.as_raw_fd(),
            libc::SOL_LOCAL,
            libc::LOCAL_PEERPID,
            (&mut pid as *mut libc::pid_t).cast(),
            &mut len,
        )
    };
    (
        (rc == 0).then_some(uid),
        (got == 0).then(|| u32::try_from(pid).ok()).flatten(),
    )
}

/// The uid on the other end of a unix socket, as the kernel states it.
fn peer_uid(s: &std::os::unix::net::UnixStream) -> Option<u32> {
    peer_cred(s).0
}

/// This process's effective uid.
/// Who owns `path` (private.rs decides whether that is trusted).
pub fn file_owner(path: &Path) -> anyhow::Result<crate::private::Owner> {
    use std::os::unix::fs::MetadataExt;
    let m = std::fs::metadata(path)
        .map_err(|e| anyhow::anyhow!("reading the owner of {}: {e}", path.display()))?;
    Ok(crate::private::Owner::Uid(m.uid()))
}

/// The uid this agent runs as.
pub fn own_uid() -> Option<u32> {
    Some(euid())
}

/// The account name of `uid`, from the user database; None when it has
/// no entry.
pub fn user_name(uid: u32) -> Option<String> {
    let mut buf = vec![0 as libc::c_char; 4096];
    // SAFETY: a zeroed passwd is a valid out-parameter; getpwuid_r writes
    // into it and `buf`, both ours and alive for the call.
    let mut pw: libc::passwd = unsafe { std::mem::zeroed() };
    let mut out: *mut libc::passwd = std::ptr::null_mut();
    // SAFETY: as above; `out` is null or points at `pw`.
    let rc = unsafe { libc::getpwuid_r(uid, &mut pw, buf.as_mut_ptr(), buf.len(), &mut out) };
    if rc != 0 || out.is_null() || pw.pw_name.is_null() {
        return None;
    }
    // SAFETY: getpwuid_r succeeded, so pw_name is a NUL-terminated string in `buf`.
    let name = unsafe { std::ffi::CStr::from_ptr(pw.pw_name) };
    Some(name.to_string_lossy().into_owned())
}

fn euid() -> u32 {
    // SAFETY: no arguments; cannot fail.
    unsafe { libc::geteuid() }
}

/// The modes the socket and a directory made for it get: private to the
/// agent's user, unless it is open to others — then the kernel's file
/// check must let them reach the socket (the directory traversable, the
/// socket connectable by all) and the peer check is the gate.
fn socket_modes(open_to_others: bool) -> (u32, u32) {
    if !open_to_others {
        (0o700, 0o600)
    } else {
        (0o711, 0o666)
    }
}

/// Make the socket's directory when it is missing — `mode`, and only what
/// this creates. One that exists is never changed, and must be a real
/// directory (not a symlink) owned by this user that neither group nor
/// others can write — else someone else could swap the socket.
fn socket_dir(dir: &Path, mode: u32) -> Result<()> {
    use std::os::unix::fs::{DirBuilderExt, MetadataExt};
    match std::fs::symlink_metadata(dir) {
        Ok(m) => check_socket_dir(
            dir,
            m.file_type().is_symlink(),
            m.is_dir(),
            m.uid(),
            m.mode(),
            euid(),
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            std::fs::DirBuilder::new()
                .recursive(true)
                .mode(mode)
                .create(dir)
                .with_context(|| format!("creating {}", dir.display()))?;
            // Exactly `mode`, whatever the umask took off: this directory
            // is the one this call made.
            std::fs::set_permissions(dir, std::os::unix::fs::PermissionsExt::from_mode(mode))
                .with_context(|| format!("making {} {mode:o}", dir.display()))
        }
        Err(e) => Err(e).with_context(|| format!("reading {}", dir.display())),
    }
}

/// The pure half of `socket_dir` for a directory that exists.
fn check_socket_dir(
    dir: &Path,
    symlink: bool,
    is_dir: bool,
    owner: u32,
    mode: u32,
    me: u32,
) -> Result<()> {
    let d = dir.display();
    if symlink {
        anyhow::bail!("{d} is a symlink; a socket's directory must be a real one");
    }
    if !is_dir {
        anyhow::bail!("{d} is not a directory");
    }
    if owner != me {
        anyhow::bail!("{d} belongs to uid {owner}, not to this agent's uid {me}");
    }
    if mode & 0o022 != 0 {
        anyhow::bail!(
            "{d} is writable by group or others (mode {:o}); a socket's directory must not be",
            mode & 0o777
        );
    }
    Ok(())
}

/// A non-blocking connect to `path`: Ok when something accepted, else the
/// error as the kernel gives it — ECONNREFUSED for a socket nobody
/// listens on, EAGAIN for a live one whose backlog is full. It never
/// waits, so a live socket cannot hang the caller.
fn probe(path: &Path) -> std::io::Result<()> {
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::os::unix::ffi::OsStrExt;
    let bytes = path.as_os_str().as_bytes();
    // SAFETY: an all-zero sockaddr_un is a valid (empty) address.
    let mut addr: libc::sockaddr_un = unsafe { std::mem::zeroed() };
    if bytes.len() >= addr.sun_path.len() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "the path is too long for a unix socket",
        ));
    }
    addr.sun_family = libc::AF_UNIX as libc::sa_family_t;
    for (d, s) in addr.sun_path.iter_mut().zip(bytes) {
        *d = *s as libc::c_char;
    }
    #[cfg(target_os = "linux")]
    let kind = libc::SOCK_STREAM | libc::SOCK_CLOEXEC | libc::SOCK_NONBLOCK;
    #[cfg(not(target_os = "linux"))]
    let kind = libc::SOCK_STREAM;
    // SAFETY: a new socket; the fd is owned below.
    let raw = unsafe { libc::socket(libc::AF_UNIX, kind, 0) };
    if raw < 0 {
        return Err(std::io::Error::last_os_error());
    }
    // SAFETY: `raw` is a fresh descriptor nothing else owns.
    let fd = unsafe { OwnedFd::from_raw_fd(raw) };
    #[cfg(not(target_os = "linux"))]
    // SAFETY: flags on a descriptor this function owns.
    unsafe {
        let fl = libc::fcntl(fd.as_raw_fd(), libc::F_GETFL);
        libc::fcntl(fd.as_raw_fd(), libc::F_SETFL, fl | libc::O_NONBLOCK);
        libc::fcntl(fd.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC);
    }
    // SAFETY: a valid address of the stated size.
    let rc = unsafe {
        libc::connect(
            fd.as_raw_fd(),
            (&addr as *const libc::sockaddr_un).cast(),
            std::mem::size_of::<libc::sockaddr_un>() as libc::socklen_t,
        )
    };
    if rc == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

/// What to do about something at the socket's path, from the probe.
#[derive(Debug, PartialEq, Eq)]
enum Stale {
    /// Nothing there (or it went away): bind.
    Clear,
    /// A socket nobody listens on: remove it, then bind.
    Remove,
}

/// The pure half of `clear_stale`: only a refused connection (or no file)
/// makes the path free; a live socket — accepting, or with its backlog
/// full — or any other error stops the start.
fn judge_probe(path: &Path, probe: std::io::Result<()>) -> Result<Stale> {
    let p = path.display();
    let e = match probe {
        Ok(()) => anyhow::bail!("another agent already answers on {p}; refusing to start a second"),
        Err(e) => e,
    };
    match e.raw_os_error() {
        Some(libc::ECONNREFUSED) => Ok(Stale::Remove),
        Some(libc::ENOENT) => Ok(Stale::Clear),
        Some(libc::EAGAIN) | Some(libc::EINPROGRESS) => anyhow::bail!(
            "another agent already answers on {p} (its backlog is full); refusing to start a second"
        ),
        _ => {
            anyhow::bail!("cannot tell whether another agent answers on {p} ({e}); not removing it")
        }
    }
}

/// Clear the way for a new socket at `path` (`judge_probe`); anything at
/// that path that is not a socket is not ours to remove.
fn clear_stale(path: &Path) -> Result<()> {
    use std::os::unix::fs::FileTypeExt;
    let Ok(meta) = std::fs::symlink_metadata(path) else {
        return Ok(());
    };
    if !meta.file_type().is_socket() {
        anyhow::bail!(
            "{} exists and is not a socket; not touching it",
            path.display()
        );
    }
    match judge_probe(path, probe(path))? {
        Stale::Clear => Ok(()),
        Stale::Remove => std::fs::remove_file(path)
            .with_context(|| format!("removing the stale {}", path.display())),
    }
}

/// Serve the API's socket at `path` (api/): the directory made if missing
/// (0700) or checked if not (`socket_dir`), a stale socket removed, another
/// instance refused, the socket 0600 — or, open to others, 0711 and 0666.
/// Each connection `policy.allow`s, while fewer than `max_connections` are
/// open, is handed to `on_conn` on a thread of its own; any other peer gets
/// `policy.refusal`, one past the limit `policy.busy`, and is closed.
pub fn serve_api_socket<F>(
    path: &Path,
    policy: &crate::door::Policy,
    on_conn: F,
) -> Result<LocalSocket>
where
    F: Fn(crate::door::Conn) + Send + Sync + 'static,
{
    serve_gated(path, policy.clone(), on_conn)
}

/// Serve the agent's local socket at `path` (local.rs), as the API's: the
/// policy says 0711 and 0666, and every exchange has its whole deadline.
pub fn serve_local<F>(path: &Path, policy: &crate::door::Policy, on_conn: F) -> Result<LocalSocket>
where
    F: Fn(crate::door::Conn) + Send + Sync + 'static,
{
    serve_gated(path, policy.clone(), on_conn)
}

/// Where the agent's local socket is: `run/agent.sock` in the data
/// directory, which moves with `DAEDALUS_AGENT_DATA_DIR` (`dev` names the
/// pipe on Windows, and nothing here).
pub fn local_socket_path(data_dir: &Path, dev: Option<&str>) -> std::path::PathBuf {
    let _ = dev;
    data_dir.join("run").join("agent.sock")
}

/// Connect to the agent's local socket at `path`, the whole exchange
/// within `timeout`, and only when the other end is one to trust
/// (`door::server_trusted`: root or this user, owning the socket file).
pub fn connect_local(path: &Path, timeout: Duration) -> std::io::Result<crate::door::Conn> {
    use crate::deadline::{Deadline, Watchdog};
    use crate::door::{server_trusted, Peer, ServerSide};
    use std::os::unix::fs::MetadataExt;
    let file_owner = std::fs::metadata(path).ok().map(|m| m.uid());
    let stream = std::os::unix::net::UnixStream::connect(path)?;
    stream.set_write_timeout(Some(timeout))?;
    let side = ServerSide::Unix {
        uid: peer_uid(&stream),
        file_owner,
    };
    if !server_trusted(&side, Some(&Peer::Uid(euid())), crate::door::dev_run()) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::PermissionDenied,
            format!(
                "{} is served by {side:?}, not root or this user owning it; not talking to it",
                path.display()
            ),
        ));
    }
    let writer = stream.try_clone()?;
    let ctl = stream.try_clone()?;
    let cut = stream.try_clone()?;
    let dog = Watchdog::arm(Deadline::after(timeout), move || {
        let _ = cut.shutdown(std::net::Shutdown::Both);
    });
    let dog = std::sync::Mutex::new(Some(dog));
    Ok(crate::door::Conn {
        reader: Box::new(stream),
        writer: Box::new(writer),
        on_hello: Box::new(|| {}),
        close: Arc::new(move || {
            drop(dog.lock_ok().take());
            let _ = ctl.shutdown(std::net::Shutdown::Both);
        }),
        end_writes: Arc::new(|| {}),
        peer: None,
        pid: None,
    })
}

/// A unix socket as a door's listener (door.rs `Listener`): each stream
/// with its write timeout and the peer's uid as the kernel states it.
struct Acceptor {
    listener: Arc<std::os::unix::net::UnixListener>,
    stop: Arc<AtomicBool>,
    write_timeout: Duration,
}

impl crate::door::Listener for Acceptor {
    fn accept(&self) -> Option<std::io::Result<crate::door::Accepted>> {
        let accepted = self.listener.accept();
        if self.stop.load(Ordering::Relaxed) {
            return None;
        }
        Some(accepted.and_then(|(stream, _)| {
            // Every write on this socket, the refusals included, gives up
            // after the timeout.
            stream.set_write_timeout(Some(self.write_timeout))?;
            let (uid, pid) = peer_cred(&stream);
            let peer = uid.map(crate::door::Peer::Uid);
            let (writer, ctl, half, cut) = (
                stream.try_clone()?,
                stream.try_clone()?,
                stream.try_clone()?,
                stream.try_clone()?,
            );
            Ok(crate::door::Accepted {
                conn: crate::door::Conn {
                    reader: Box::new(stream),
                    writer: Box::new(writer),
                    on_hello: Box::new(|| {}),
                    close: Arc::new(move || {
                        let _ = ctl.shutdown(std::net::Shutdown::Both);
                    }),
                    end_writes: Arc::new(move || {
                        let _ = half.shutdown(std::net::Shutdown::Write);
                    }),
                    peer: None,
                    pid,
                },
                abort: Arc::new(move || {
                    let _ = cut.shutdown(std::net::Shutdown::Both);
                }),
                peer: crate::door::PeerAt::Now(peer),
            })
        }))
    }
}

/// The core of both: make the directory and the socket, then serve it as a
/// door (door.rs `serve`).
fn serve_gated<F>(path: &Path, gate: crate::door::Policy, on_conn: F) -> Result<LocalSocket>
where
    F: Fn(crate::door::Conn) + Send + Sync + 'static,
{
    use std::os::unix::fs::{MetadataExt, PermissionsExt};
    use std::os::unix::net::UnixListener;
    let dir = path
        .parent()
        .filter(|d| !d.as_os_str().is_empty())
        .with_context(|| format!("{} names no directory", path.display()))?;
    let (dir_mode, sock_mode) = socket_modes(gate.open_to_others);
    socket_dir(dir, dir_mode)?;
    clear_stale(path)?;
    let listener =
        UnixListener::bind(path).with_context(|| format!("binding {}", path.display()))?;
    std::fs::set_permissions(path, std::fs::Permissions::from_mode(sock_mode))
        .with_context(|| format!("making {} {sock_mode:o}", path.display()))?;
    let ino = std::fs::symlink_metadata(path)
        .with_context(|| format!("reading {}", path.display()))?
        .ino();
    let stop = Arc::new(AtomicBool::new(false));
    let listener = Arc::new(listener);
    let acceptor = Acceptor {
        listener: Arc::clone(&listener),
        stop: Arc::clone(&stop),
        write_timeout: gate.write_timeout,
    };
    crate::door::serve(acceptor, gate, on_conn).context("spawning a socket's accept thread")?;
    Ok(LocalSocket {
        path: path.to_path_buf(),
        ino,
        stop,
        listener,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::door::Conn;
    use crate::door::Policy;
    use std::io::{BufRead, BufReader, Read, Write};

    fn scratch(name: &str) -> std::path::PathBuf {
        std::env::temp_dir().join(format!("daedalus-sock-{name}-{}", std::process::id()))
    }

    fn limits() -> Policy {
        let own = euid();
        Policy {
            what: "test",
            allow: Arc::new(move |p| p == Some(&crate::door::Peer::Uid(own))),
            refusal: Arc::new(|_| "refused\n".into()),
            busy: "busy\n".into(),
            max_connections: 16,
            first_line: Duration::from_secs(10),
            write_timeout: Duration::from_secs(10),
            whole: None,
            open_to_others: false,
        }
    }

    fn echo(c: Conn) {
        let mut w = c.writer;
        for line in BufReader::new(c.reader).lines().map_while(|l| l.ok()) {
            let _ = writeln!(w, "{line}");
        }
    }

    fn read_one(c: &std::os::unix::net::UnixStream) -> String {
        let mut got = String::new();
        BufReader::new(c).read_line(&mut got).unwrap();
        got
    }

    #[test]
    fn the_socket_is_private_single_and_cleaned_up() {
        use std::os::unix::fs::PermissionsExt;
        let dir = scratch("life");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("run").join("api.sock");
        let sock = serve_api_socket(&path, &limits(), echo).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        // This uid is served.
        let mut c = std::os::unix::net::UnixStream::connect(&path).unwrap();
        writeln!(c, "ping").unwrap();
        assert_eq!(read_one(&c), "ping\n");
        // A second instance is refused while this one answers.
        let e = serve_api_socket(&path, &limits(), echo)
            .err()
            .unwrap()
            .to_string();
        assert!(e.contains("already answers"), "{e}");
        drop(sock);
        assert!(!path.exists(), "the socket leaves with its server");

        // A stale socket (nobody answers) is replaced; a file is not touched.
        drop(std::os::unix::net::UnixListener::bind(&path).unwrap());
        assert!(path.exists());
        // Other tests spawn processes; a child forked while the listener
        // was open holds it until it execs, and the socket answers until
        // then — which is exactly a second instance, so wait it out.
        let until = std::time::Instant::now() + Duration::from_secs(5);
        let sock = loop {
            match serve_api_socket(&path, &limits(), echo) {
                Ok(s) => break s,
                Err(e) if std::time::Instant::now() < until => {
                    assert!(e.to_string().contains("already answers"), "{e}");
                    std::thread::sleep(Duration::from_millis(20));
                }
                Err(e) => panic!("{e}"),
            }
        };
        drop(sock);
        std::fs::write(&path, "not a socket").unwrap();
        let e = serve_api_socket(&path, &limits(), echo)
            .err()
            .unwrap()
            .to_string();
        assert!(e.contains("not a socket"), "{e}");
        assert!(path.exists());
        std::fs::remove_file(&path).unwrap();
        // A directory that exists keeps its mode, and is refused when the
        // group or others can write it, or when it is a symlink.
        let run = path.parent().unwrap();
        std::fs::set_permissions(run, std::fs::Permissions::from_mode(0o750)).unwrap();
        drop(serve_api_socket(&path, &limits(), echo).unwrap());
        assert_eq!(mode(run), 0o750);
        std::fs::set_permissions(run, std::fs::Permissions::from_mode(0o770)).unwrap();
        let e = serve_api_socket(&path, &limits(), echo)
            .err()
            .unwrap()
            .to_string();
        assert!(e.contains("writable by group or others"), "{e}");
        assert_eq!(mode(run), 0o770, "never chmods a directory it did not make");
        let link = dir.join("link");
        std::os::unix::fs::symlink(run, &link).unwrap();
        let e = serve_api_socket(&link.join("api.sock"), &limits(), echo)
            .err()
            .unwrap()
            .to_string();
        assert!(e.contains("symlink"), "{e}");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn listed_uids_open_the_file_modes_and_leave_the_gate_to_the_peer_check() {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(socket_modes(false), (0o700, 0o600));
        assert_eq!(socket_modes(true), (0o711, 0o666));
        let dir = scratch("listed");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("run").join("api.sock");
        let open = Policy {
            open_to_others: true,
            ..limits()
        };
        let sock = serve_api_socket(&path, &open, echo).unwrap();
        let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o666);
        assert_eq!(mode(path.parent().unwrap()), 0o711);
        drop(sock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_directory_that_is_not_ours_is_refused() {
        let d = Path::new("/run/x");
        assert!(check_socket_dir(d, false, true, 1000, 0o40700, 1000).is_ok());
        assert!(check_socket_dir(d, false, true, 1000, 0o40755, 1000).is_ok());
        let e = check_socket_dir(d, false, true, 0, 0o40700, 1000).unwrap_err();
        assert!(e.to_string().contains("belongs to uid 0"), "{e}");
        assert!(check_socket_dir(d, false, true, 1000, 0o40702, 1000).is_err());
        assert!(check_socket_dir(d, true, false, 1000, 0o120777, 1000).is_err());
        assert!(check_socket_dir(d, false, false, 1000, 0o100600, 1000).is_err());
    }

    #[test]
    fn only_a_refused_probe_frees_the_path() {
        let p = Path::new("/run/x/api.sock");
        let err = |n| Err(std::io::Error::from_raw_os_error(n));
        assert_eq!(
            judge_probe(p, err(libc::ECONNREFUSED)).unwrap(),
            Stale::Remove
        );
        assert_eq!(judge_probe(p, err(libc::ENOENT)).unwrap(), Stale::Clear);
        for live in [Ok(()), err(libc::EAGAIN)] {
            let e = judge_probe(p, live).unwrap_err().to_string();
            assert!(e.contains("already answers"), "{e}");
        }
        let e = judge_probe(p, err(libc::EACCES)).unwrap_err().to_string();
        assert!(e.contains("not removing it"), "{e}");
    }

    #[test]
    fn past_the_limit_a_connection_is_told_busy_and_closed() {
        let dir = scratch("busy");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("api.sock");
        let one = Policy {
            max_connections: 1,
            ..limits()
        };
        let sock = serve_api_socket(&path, &one, echo).unwrap();
        let mut first = std::os::unix::net::UnixStream::connect(&path).unwrap();
        writeln!(first, "held").unwrap();
        assert_eq!(read_one(&first), "held\n");
        let second = std::os::unix::net::UnixStream::connect(&path).unwrap();
        assert_eq!(read_one(&second), one.busy);
        let mut rest = String::new();
        (&second).read_to_string(&mut rest).unwrap();
        assert_eq!(rest, "", "closed after the line");
        // The slot comes back when the first leaves.
        drop(first);
        let until = std::time::Instant::now() + Duration::from_secs(5);
        loop {
            let mut again = std::os::unix::net::UnixStream::connect(&path).unwrap();
            writeln!(again, "back").unwrap();
            if read_one(&again) == "back\n" {
                break;
            }
            assert!(
                std::time::Instant::now() < until,
                "the slot never came back"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(sock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_silent_connection_is_closed_at_the_hello_deadline() {
        let dir = scratch("deadline");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("api.sock");
        let quick = Policy {
            first_line: Duration::from_millis(200),
            ..limits()
        };
        let sock = serve_api_socket(&path, &quick, echo).unwrap();
        let c = std::os::unix::net::UnixStream::connect(&path).unwrap();
        let t = std::time::Instant::now();
        let mut rest = String::new();
        (&c).read_to_string(&mut rest).unwrap();
        assert!(t.elapsed() < Duration::from_secs(3), "{:?}", t.elapsed());
        drop(sock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_peer_that_never_reads_does_not_pin_the_connection() {
        let dir = scratch("stuck");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("api.sock");
        let quick = Policy {
            write_timeout: Duration::from_millis(200),
            ..limits()
        };
        let done = std::sync::Arc::new(AtomicBool::new(false));
        let sock = {
            let done = std::sync::Arc::clone(&done);
            serve_api_socket(&path, &quick, move |c: Conn| {
                // Write until the socket gives up on the reader.
                let mut w = c.writer;
                let chunk = vec![b'x'; 64 * 1024];
                while w.write_all(&chunk).is_ok() {}
                (c.close)();
                done.store(true, Ordering::SeqCst);
            })
            .unwrap()
        };
        let c = std::os::unix::net::UnixStream::connect(&path).unwrap();
        c.shutdown(std::net::Shutdown::Write).unwrap();
        let until = std::time::Instant::now() + Duration::from_secs(5);
        while !done.load(Ordering::SeqCst) {
            assert!(std::time::Instant::now() < until, "the write never gave up");
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(c);
        drop(sock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A peer that trickles its first line a byte at a time — each byte
    /// well inside any per-read timeout — is cut off at the first line's
    /// deadline, and its slot comes back (audit D17, D4's local twin).
    #[test]
    fn a_trickled_first_line_is_cut_off_at_its_deadline() {
        let dir = scratch("trickle");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("api.sock");
        let quick = Policy {
            first_line: Duration::from_millis(400),
            max_connections: 1,
            ..limits()
        };
        let sock = serve_api_socket(&path, &quick, |c: Conn| {
            // Reads forever, as the API's reader does before `hello`.
            let mut sink = Vec::new();
            let _ = std::io::Read::read_to_end(&mut { c.reader }, &mut sink);
            (c.close)();
        })
        .unwrap();
        let mut c = std::os::unix::net::UnixStream::connect(&path).unwrap();
        let t = std::time::Instant::now();
        while t.elapsed() < Duration::from_secs(4) {
            if c.write_all(b"x").is_err() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(t.elapsed() < Duration::from_secs(2), "{:?}", t.elapsed());
        // The one slot is free again.
        let until = std::time::Instant::now() + Duration::from_secs(3);
        loop {
            let again = std::os::unix::net::UnixStream::connect(&path).unwrap();
            again
                .set_read_timeout(Some(Duration::from_millis(200)))
                .unwrap();
            let mut got = String::new();
            let busy = BufReader::new(&again).read_line(&mut got).is_ok() && got == "busy\n";
            if !busy {
                break;
            }
            assert!(
                std::time::Instant::now() < until,
                "the slot never came back"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        drop(sock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// A handler blocked writing to a peer that never reads, with no write
    /// timeout to save it, is freed at the whole exchange's deadline (the
    /// pipe's D8 on every OS: the watchdog, not the write timeout).
    #[test]
    fn a_peer_that_never_reads_is_cut_off_at_the_whole_deadline() {
        let dir = scratch("never");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("agent.sock");
        let whole = Policy {
            whole: Some(Duration::from_millis(400)),
            write_timeout: Duration::from_secs(3600),
            ..limits()
        };
        let done = std::sync::Arc::new(AtomicBool::new(false));
        let sock = {
            let done = std::sync::Arc::clone(&done);
            serve_local(&path, &whole, move |c: Conn| {
                let mut w = c.writer;
                let chunk = vec![b'x'; 64 * 1024];
                while w.write_all(&chunk).is_ok() {}
                done.store(true, Ordering::SeqCst);
            })
            .unwrap()
        };
        let c = std::os::unix::net::UnixStream::connect(&path).unwrap();
        let t = std::time::Instant::now();
        while !done.load(Ordering::SeqCst) {
            assert!(t.elapsed() < Duration::from_secs(3), "never cut off");
            std::thread::sleep(Duration::from_millis(20));
        }
        drop(c);
        drop(sock);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_stop_never_waits_even_with_the_file_gone() {
        let dir = scratch("gone");
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("api.sock");
        let sock = serve_api_socket(&path, &limits(), |_| {}).unwrap();
        std::fs::remove_dir_all(&dir).unwrap();
        let t = std::time::Instant::now();
        drop(sock);
        assert!(t.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn the_kernel_names_the_peer() {
        let (a, _b) = std::os::unix::net::UnixStream::pair().unwrap();
        assert_eq!(peer_uid(&a), Some(euid()));
        assert_eq!(peer_cred(&a), (Some(euid()), Some(std::process::id())));
    }
}
