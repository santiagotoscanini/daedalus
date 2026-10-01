//! The agent's local door on Windows (ipc/local/): a named pipe whose DACL
//! lets SYSTEM, the pipe's owner and the interactive users in — the users
//! read and write data, never create an instance of their own, so nobody
//! can stand a second server up beside the service — and that refuses
//! remote clients. The service reads each client's request, then takes its
//! user from the client's own token while impersonating it
//! (`ImpersonateNamedPipeClient`, at identification level only) — never by
//! opening its process — and the gate judges that user. Each client checks
//! the server by what it can see without opening the service's process:
//! the pipe object's owner (SYSTEM or Administrators) and the server's
//! session (0).
//!
//! Synchronous pipes served as a door (door.rs `serve`): a thread per
//! connection under a watchdog that cancels the call it is blocked in
//! (`CancelIoEx`, then `DisconnectNamedPipe`) when its deadline passes, and
//! again until the thread lets go — so no peer holds a thread by not
//! writing, not reading, or leaving a flush pending (audit D8).

use std::ffi::c_void;
use std::io;
use std::os::windows::io::{FromRawHandle, RawHandle};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::{Context, Result};
use windows::core::{PCWSTR, PWSTR};
use windows::Win32::Foundation::{
    CloseHandle, LocalFree, ERROR_PIPE_BUSY, ERROR_PIPE_CONNECTED, ERROR_SUCCESS, HANDLE, HLOCAL,
};
use windows::Win32::Security::Authorization::{
    ConvertSidToStringSidW, ConvertStringSecurityDescriptorToSecurityDescriptorW, GetSecurityInfo,
    SDDL_REVISION_1, SE_KERNEL_OBJECT,
};
use windows::Win32::Security::{
    GetTokenInformation, IsWellKnownSid, RevertToSelf, TokenUser, WinBuiltinAdministratorsSid,
    WinLocalSystemSid, OWNER_SECURITY_INFORMATION, PSECURITY_DESCRIPTOR, PSID, SECURITY_ATTRIBUTES,
    TOKEN_QUERY, TOKEN_USER,
};
use windows::Win32::Storage::FileSystem::{
    CreateFileW, FlushFileBuffers, FILE_FLAG_FIRST_PIPE_INSTANCE, FILE_GENERIC_READ,
    FILE_SHARE_NONE, FILE_WRITE_DATA, OPEN_EXISTING, PIPE_ACCESS_DUPLEX, SECURITY_IDENTIFICATION,
    SECURITY_SQOS_PRESENT,
};
use windows::Win32::System::Pipes::{
    ConnectNamedPipe, CreateNamedPipeW, DisconnectNamedPipe, GetNamedPipeServerSessionId,
    ImpersonateNamedPipeClient, WaitNamedPipeW, PIPE_READMODE_BYTE, PIPE_REJECT_REMOTE_CLIENTS,
    PIPE_TYPE_BYTE, PIPE_UNLIMITED_INSTANCES, PIPE_WAIT,
};
use windows::Win32::System::RemoteDesktop::{
    WTSActive, WTSDisconnected, WTSEnumerateSessionsW, WTSFreeMemory, WTSQueryUserToken,
    WTS_SESSION_INFOW,
};
use windows::Win32::System::Threading::{
    GetCurrentProcess, GetCurrentThread, OpenProcessToken, OpenThreadToken,
};
use windows::Win32::System::IO::CancelIoEx;

use crate::ipc::door::Conn;
use crate::ipc::door::{Allowed, Peer, Policy};
use crate::util::LockExt;

/// SYSTEM and the pipe's owner (the service) everything; the interactive
/// users FILE_GENERIC_READ | FILE_WRITE_DATA (0x12008b) — without
/// FILE_APPEND_DATA, which on a pipe is the right to create an instance.
const SDDL: &str = "D:P(A;;GA;;;SY)(A;;GA;;;OW)(A;;0x12008b;;;IU)";
/// Each instance's buffers, each way.
const BUFFER: u32 = 64 * 1024;

fn wide(path: &Path) -> Vec<u16> {
    use std::os::windows::ffi::OsStrExt;
    path.as_os_str().encode_wide().chain(Some(0)).collect()
}

fn win_err(e: windows::core::Error) -> io::Error {
    io::Error::other(e.message())
}

/// The string SID a token's user has.
///
/// SAFETY: `token` is a token handle open for TOKEN_QUERY.
unsafe fn token_sid(token: HANDLE) -> Option<String> {
    let mut len = 0u32;
    let _ = GetTokenInformation(token, TokenUser, None, 0, &mut len);
    if len == 0 {
        return None;
    }
    // u64s, so the TOKEN_USER the buffer holds is aligned.
    let mut buf = vec![0u64; (len as usize).div_ceil(8)];
    GetTokenInformation(
        token,
        TokenUser,
        Some(buf.as_mut_ptr().cast::<c_void>()),
        len,
        &mut len,
    )
    .ok()?;
    let user = &*(buf.as_ptr().cast::<TOKEN_USER>());
    let mut s = PWSTR::null();
    ConvertSidToStringSidW(user.User.Sid, &mut s).ok()?;
    let out = s.to_string().ok();
    let _ = LocalFree(Some(HLOCAL(s.0.cast())));
    out
}

/// The user on the client end of a connected instance, from the client's
/// own token while the server thread impersonates it — no process to open,
/// no pid to be reused. The client opened the pipe at identification
/// level, so the impersonation can identify it and do nothing as it.
/// Only valid once the client has written (the request is read first).
fn client_sid(h: HANDLE) -> Option<Peer> {
    // SAFETY: the impersonation is ended on every path before returning
    // (and the process ends rather than run on as the client); the token
    // is closed.
    unsafe {
        ImpersonateNamedPipeClient(h).ok()?;
        let mut t = HANDLE::default();
        let opened = OpenThreadToken(GetCurrentThread(), TOKEN_QUERY, true, &mut t);
        if RevertToSelf().is_err() {
            std::process::abort();
        }
        opened.ok()?;
        let sid = token_sid(t);
        let _ = CloseHandle(t);
        sid.map(Peer::Sid)
    }
}

/// What the client can see of the server without opening its process
/// (which a non-elevated user cannot, the service being SYSTEM): the pipe
/// object's owner, and the server's session.
fn server_side(h: HANDLE) -> crate::ipc::door::ServerSide {
    let mut owner = PSID::default();
    let mut sd = PSECURITY_DESCRIPTOR::default();
    // SAFETY: out pointers valid for the call; `owner` points into `sd`,
    // read before `sd` is freed.
    let (owner_sid, privileged) = unsafe {
        let err = GetSecurityInfo(
            h,
            SE_KERNEL_OBJECT,
            OWNER_SECURITY_INFORMATION,
            Some(&mut owner),
            None,
            None,
            None,
            Some(&mut sd),
        );
        let out = if err == ERROR_SUCCESS && !owner.is_invalid() {
            let privileged = IsWellKnownSid(owner, WinLocalSystemSid).as_bool()
                || IsWellKnownSid(owner, WinBuiltinAdministratorsSid).as_bool();
            let mut s = PWSTR::null();
            let text = ConvertSidToStringSidW(owner, &mut s)
                .ok()
                .and_then(|()| s.to_string().ok());
            if !s.is_null() {
                let _ = LocalFree(Some(HLOCAL(s.0.cast())));
            }
            (text, privileged)
        } else {
            (None, false)
        };
        if !sd.is_invalid() {
            let _ = LocalFree(Some(HLOCAL(sd.0)));
        }
        out
    };
    let mut session = 0u32;
    // SAFETY: the connected handle.
    let session = unsafe { GetNamedPipeServerSessionId(h, &mut session) }
        .ok()
        .map(|()| session);
    crate::ipc::door::ServerSide::Pipe {
        owner: owner_sid,
        owner_privileged: privileged,
        session,
    }
}

/// This process's own user.
fn own_sid() -> Option<Peer> {
    // SAFETY: the pseudo-handle needs no closing; the token is closed.
    unsafe {
        let mut t = HANDLE::default();
        OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut t).ok()?;
        let sid = token_sid(t);
        let _ = CloseHandle(t);
        sid.map(Peer::Sid)
    }
}

/// Whom the pipe serves (ipc/local/): SYSTEM, this process's own user (a
/// development run's), and the user of every session someone is logged on
/// to, at the console or remotely — each of whom has a tray that runs
/// Claude. Read at each connection.
pub fn local_allowed() -> Allowed {
    let mut sids: Vec<String> = own_sid()
        .into_iter()
        .filter_map(|p| match p {
            Peer::Sid(s) => Some(s),
            Peer::Uid(_) => None,
        })
        .collect();
    // SAFETY: the session list is freed with WTSFreeMemory, each token closed.
    unsafe {
        let mut info: *mut WTS_SESSION_INFOW = std::ptr::null_mut();
        let mut n = 0u32;
        if WTSEnumerateSessionsW(None, 0, 1, &mut info, &mut n).is_ok() && !info.is_null() {
            for s in std::slice::from_raw_parts(info, n as usize) {
                if s.SessionId == 0 || !(s.State == WTSActive || s.State == WTSDisconnected) {
                    continue;
                }
                let mut t = HANDLE::default();
                if WTSQueryUserToken(s.SessionId, &mut t).is_ok() {
                    if let Some(sid) = token_sid(t) {
                        sids.push(sid);
                    }
                    let _ = CloseHandle(t);
                }
            }
            WTSFreeMemory(info.cast());
        }
    }
    sids.sort();
    sids.dedup();
    crate::ipc::door::windows_allowed(sids)
}

/// The pipe's name: `\\.\pipe\daedalus-agent`, or with a development run's
/// suffix (`dev`, config.rs).
pub fn local_socket_path(data_dir: &Path, dev: Option<&str>) -> std::path::PathBuf {
    let _ = data_dir;
    match dev {
        None => r"\\.\pipe\daedalus-agent".into(),
        Some(d) => format!(r"\\.\pipe\daedalus-agent-{d}").into(),
    }
}

/// The pipe's security descriptor, freed when dropped.
struct Descriptor(PSECURITY_DESCRIPTOR);

// SAFETY: a self-contained block of memory nothing else refers to.
unsafe impl Send for Descriptor {}

impl Descriptor {
    fn new() -> Result<Self> {
        let sddl: Vec<u16> = SDDL.encode_utf16().chain(Some(0)).collect();
        let mut sd = PSECURITY_DESCRIPTOR::default();
        // SAFETY: a NUL-terminated SDDL string; the descriptor is freed on drop.
        unsafe {
            ConvertStringSecurityDescriptorToSecurityDescriptorW(
                PCWSTR(sddl.as_ptr()),
                SDDL_REVISION_1,
                &mut sd,
                None,
            )
        }
        .context("building the pipe's security descriptor")?;
        Ok(Self(sd))
    }
}

impl Drop for Descriptor {
    fn drop(&mut self) {
        // SAFETY: allocated by the conversion above.
        unsafe {
            let _ = LocalFree(Some(HLOCAL(self.0 .0)));
        }
    }
}

/// One instance of the pipe; the first must be the first of its name.
fn instance(name: &[u16], sd: &Descriptor, first: bool) -> io::Result<HANDLE> {
    let attrs = SECURITY_ATTRIBUTES {
        nLength: std::mem::size_of::<SECURITY_ATTRIBUTES>() as u32,
        lpSecurityDescriptor: sd.0 .0,
        bInheritHandle: false.into(),
    };
    let mut mode = PIPE_ACCESS_DUPLEX;
    if first {
        mode |= FILE_FLAG_FIRST_PIPE_INSTANCE;
    }
    // SAFETY: a NUL-terminated name and attributes that outlive the call.
    let h = unsafe {
        CreateNamedPipeW(
            PCWSTR(name.as_ptr()),
            mode,
            PIPE_TYPE_BYTE | PIPE_READMODE_BYTE | PIPE_WAIT | PIPE_REJECT_REMOTE_CLIENTS,
            PIPE_UNLIMITED_INSTANCES,
            BUFFER,
            BUFFER,
            0,
            Some(&attrs),
        )
    };
    if h.is_invalid() {
        return Err(io::Error::last_os_error());
    }
    Ok(h)
}

/// One pipe handle, both halves of a `Conn` over it: one handle, so
/// `CancelIoEx` on it reaches whatever call the connection's thread is
/// blocked in.
struct PipeIo(Arc<std::fs::File>);

impl io::Read for PipeIo {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        io::Read::read(&mut &*self.0, buf)
    }
}

impl io::Write for PipeIo {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        io::Write::write(&mut &*self.0, buf)
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn raw(f: &std::fs::File) -> HANDLE {
    use std::os::windows::io::AsRawHandle;
    HANDLE(f.as_raw_handle())
}

/// Cancel every call blocked on `f`, from any thread; on a server's end,
/// disconnect the client too, so a call started after this one fails at
/// once.
fn cut(f: &std::fs::File, server: bool) {
    // SAFETY: the handle `f` keeps open.
    unsafe {
        let _ = CancelIoEx(raw(f), None);
        if server {
            let _ = DisconnectNamedPipe(raw(f));
        }
    }
}

/// A pipe handle as a `Conn`, and what tears it down at once (the
/// watchdog's). A server's graceful `close` flushes what it wrote to the
/// client — a flush that waits for the client to read, so it is only ever
/// called under a watchdog — then disconnects.
fn conn_of(h: HANDLE, server: bool) -> (Conn, Arc<dyn Fn() + Send + Sync>) {
    // SAFETY: `h` is an open pipe handle this function now owns.
    let file = Arc::new(unsafe { std::fs::File::from_raw_handle(h.0 as RawHandle) });
    let (ctl, aborter) = (Arc::clone(&file), Arc::clone(&file));
    let conn = Conn {
        reader: Box::new(PipeIo(Arc::clone(&file))),
        writer: Box::new(PipeIo(file)),
        on_hello: Box::new(|| {}),
        close: Arc::new(move || {
            if server {
                // SAFETY: the handle `ctl` keeps open.
                unsafe {
                    let _ = FlushFileBuffers(raw(&ctl));
                    let _ = DisconnectNamedPipe(raw(&ctl));
                }
            }
        }),
        end_writes: Arc::new(|| {}),
        peer: None,
        pid: None,
    };
    (conn, Arc::new(move || cut(&aborter, server)))
}

/// The pipe as a door's listener (door.rs `Listener`): each instance
/// connected, the next made before it is handed over (so a client always
/// finds one waiting), the client's user read once it has written.
struct Acceptor {
    name: Vec<u16>,
    sd: Descriptor,
    stop: Arc<AtomicBool>,
    next: Mutex<Option<usize>>,
}

impl crate::ipc::door::Listener for Acceptor {
    fn accept(&self) -> Option<io::Result<crate::ipc::door::Accepted>> {
        loop {
            let waiting = self.next.lock_ok().take();
            let this = match waiting {
                Some(h) => HANDLE(h as *mut c_void),
                None => match instance(&self.name, &self.sd, false) {
                    Ok(h) => h,
                    Err(e) => {
                        if self.stop.load(Ordering::Relaxed) {
                            return None;
                        }
                        return Some(Err(e));
                    }
                },
            };
            // SAFETY: a pipe instance this listener owns.
            let connected = match unsafe { ConnectNamedPipe(this, None) } {
                Ok(()) => true,
                Err(e) => e.code() == ERROR_PIPE_CONNECTED.to_hresult(),
            };
            if self.stop.load(Ordering::Relaxed) {
                // SAFETY: ours.
                unsafe {
                    let _ = CloseHandle(this);
                }
                return None;
            }
            *self.next.lock_ok() = instance(&self.name, &self.sd, false)
                .ok()
                .map(|h| h.0 as usize);
            if !connected {
                // SAFETY: ours.
                unsafe {
                    let _ = CloseHandle(this);
                }
                continue;
            }
            let raw_h = this.0 as usize;
            let (conn, abort) = conn_of(this, true);
            return Some(Ok(crate::ipc::door::Accepted {
                conn,
                abort,
                peer: crate::ipc::door::PeerAt::AfterRequest(Box::new(move || {
                    client_sid(HANDLE(raw_h as *mut c_void))
                })),
            }));
        }
    }
}

// SAFETY: the waiting instance is a handle value only this listener uses.
unsafe impl Send for Acceptor {}
// SAFETY: as above; the handle is behind the mutex.
unsafe impl Sync for Acceptor {}

/// The pipe while it is served; dropping it stops accepting.
pub struct LocalSocket {
    name: Vec<u16>,
    stop: Arc<AtomicBool>,
}

impl Drop for LocalSocket {
    /// The accept thread waits in `ConnectNamedPipe`: a connection of our
    /// own wakes it to see the stop. Never joined.
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Relaxed);
        // SAFETY: a NUL-terminated name; the handle, if any, is closed.
        unsafe {
            if let Ok(h) = CreateFileW(
                PCWSTR(self.name.as_ptr()),
                (FILE_GENERIC_READ | FILE_WRITE_DATA).0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                None,
            ) {
                let _ = CloseHandle(h);
            }
        }
    }
}

/// Serve the pipe at `path` (module doc) as a door (door.rs `serve`):
/// refused when an instance of that name exists already (another agent, or
/// a squatter).
pub fn serve_local<F>(path: &Path, policy: &Policy, on_conn: F) -> Result<LocalSocket>
where
    F: Fn(Conn) + Send + Sync + 'static,
{
    let name = wide(path);
    let sd = Descriptor::new()?;
    let first = instance(&name, &sd, true).with_context(|| {
        format!(
            "creating the pipe {} (does another agent already serve it?)",
            path.display()
        )
    })?;
    let stop = Arc::new(AtomicBool::new(false));
    let acceptor = Acceptor {
        name: name.clone(),
        sd,
        stop: Arc::clone(&stop),
        next: Mutex::new(Some(first.0 as usize)),
    };
    crate::ipc::door::serve(acceptor, policy.clone(), on_conn)
        .context("spawning the pipe's accept thread")?;
    Ok(LocalSocket { name, stop })
}

/// Connect to the pipe at `path`, waiting at most `timeout` for a free
/// instance, and only when its server is a service (the pipe owned by
/// SYSTEM or Administrators, served from session 0), or in a development
/// run this user (`door::server_trusted`). The whole exchange on the
/// returned connection has `timeout`: past it every call on the pipe is
/// cancelled, again until the connection is closed.
pub fn connect_local(path: &Path, timeout: Duration) -> io::Result<Conn> {
    use crate::ipc::deadline::{Deadline, Watchdog};
    let name = wide(path);
    let deadline = Deadline::after(timeout);
    let h = loop {
        // SAFETY: a NUL-terminated name. The server may only identify this
        // client, never act as it (SECURITY_IDENTIFICATION).
        match unsafe {
            CreateFileW(
                PCWSTR(name.as_ptr()),
                (FILE_GENERIC_READ | FILE_WRITE_DATA).0,
                FILE_SHARE_NONE,
                None,
                OPEN_EXISTING,
                SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION,
                None,
            )
        } {
            Ok(h) => break h,
            Err(e) if e.code() == ERROR_PIPE_BUSY.to_hresult() && !deadline.passed() => {
                let wait = deadline.timeout(Duration::from_millis(500)).as_millis() as u32;
                // SAFETY: a NUL-terminated name.
                let _ = unsafe { WaitNamedPipeW(PCWSTR(name.as_ptr()), wait) };
            }
            Err(e) => return Err(win_err(e)),
        }
    };
    // Never the server's process: the service is SYSTEM, which a user's
    // tray cannot open. The pipe object's owner and the server's session
    // say who made it (`door::server_trusted`).
    let side = server_side(h);
    if !crate::ipc::door::server_trusted(&side, own_sid().as_ref(), crate::ipc::door::dev_run()) {
        // SAFETY: ours.
        unsafe {
            let _ = CloseHandle(h);
        }
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            format!(
                "{} is served by {side:?}, not a service's pipe; not talking to it",
                path.display()
            ),
        ));
    }
    let (mut conn, abort) = conn_of(h, false);
    let dog = Mutex::new(Some(Watchdog::arm(deadline, move || abort())));
    conn.close = Arc::new(move || {
        drop(dog.lock_ok().take());
    });
    Ok(conn)
}
