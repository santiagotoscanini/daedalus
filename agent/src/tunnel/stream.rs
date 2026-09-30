//! A TCP connection through the tunnel, with what the link and the santree
//! pipe use of a `TcpStream`: blocking reads and writes under the
//! connection's timeouts (a timeout is `WouldBlock`, as a socket's is),
//! half-closes, and clones that share the connection. A read or write moves
//! its bytes under the tunnel's lock and pushes what they produced out at
//! once (core.rs `poll`); a wait sleeps on the tunnel's condition variable,
//! which the thread raises whenever anything moved.

use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, SocketAddrV4};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::Duration;

use smoltcp::iface::SocketHandle;
use smoltcp::socket::tcp;

use super::core::{Core, Inner};
use super::{TCP_BUFFER, TCP_TIMEOUT};
use crate::deadline::Deadline;
use crate::util::LockExt;

/// One connection; clones share it (module doc). The last one dropped
/// closes it.
#[derive(Clone)]
pub struct Stream(Arc<Handle>);

struct Handle {
    inner: Arc<Inner>,
    socket: SocketHandle,
    peer: SocketAddr,
    read_timeout: Mutex<Option<Duration>>,
    write_timeout: Mutex<Option<Duration>>,
    /// `shutdown(Read)`: reads end, as a socket's do.
    read_shut: AtomicBool,
}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.inner.stopped.load(Ordering::SeqCst) {
            self.inner.core.lock_ok().orphan(self.socket);
        }
        self.inner.moved.notify_all();
    }
}

fn stopped() -> io::Error {
    io::Error::new(io::ErrorKind::NotConnected, "the tunnel stopped")
}

/// Open a connection to `to` and wait until it is established or
/// `deadline` passes.
pub(super) fn connect(
    inner: &Arc<Inner>,
    to: SocketAddrV4,
    deadline: Deadline,
) -> Result<Stream, String> {
    if inner.stopped.load(Ordering::SeqCst) {
        return Err("the tunnel stopped".into());
    }
    let handle = {
        let mut core = inner.core.lock_ok();
        let mut socket = tcp::Socket::new(
            tcp::SocketBuffer::new(vec![0; TCP_BUFFER]),
            tcp::SocketBuffer::new(vec![0; TCP_BUFFER]),
        );
        socket.set_nagle_enabled(false);
        socket.set_timeout(Some(smoltcp::time::Duration::from_secs(
            TCP_TIMEOUT.as_secs(),
        )));
        socket.set_congestion_control(tcp::CongestionControl::Cubic);
        core.sockets.add(socket)
    };
    // From here the stream owns the socket: dropping it on a failure below
    // (after the lock is let go) orphans it.
    let stream = Stream(Arc::new(Handle {
        inner: Arc::clone(inner),
        socket: handle,
        peer: SocketAddr::V4(to),
        read_timeout: Mutex::new(None),
        write_timeout: Mutex::new(None),
        read_shut: AtomicBool::new(false),
    }));
    let established = (|| {
        let mut core = inner.core.lock_ok();
        let port = core.port();
        core.connect(handle, to, port)?;
        core.poll();
        loop {
            if inner.stopped.load(Ordering::SeqCst) {
                return Err("the tunnel stopped".to_string());
            }
            match core.sockets.get::<tcp::Socket>(handle).state() {
                tcp::State::Established => return Ok(()),
                tcp::State::Closed => {
                    return Err(format!(
                        "{to} refused the connection through the tunnel{}",
                        core.trouble()
                    ))
                }
                _ => {}
            }
            if deadline.passed() {
                return Err(format!(
                    "{to} did not answer through the tunnel{}",
                    core.trouble()
                ));
            }
            core = inner
                .moved
                .wait_timeout(core, deadline.remaining())
                .map(|(g, _)| g)
                .unwrap_or_else(|p| p.into_inner().0);
        }
    })();
    established.map(|()| stream)
}

impl Stream {
    pub fn set_read_timeout(&self, d: Option<Duration>) -> io::Result<()> {
        *self.0.read_timeout.lock_ok() = d;
        Ok(())
    }

    pub fn set_write_timeout(&self, d: Option<Duration>) -> io::Result<()> {
        *self.0.write_timeout.lock_ok() = d;
        Ok(())
    }

    pub fn peer_addr(&self) -> SocketAddr {
        self.0.peer
    }

    /// `Write`: say goodbye (FIN), reads go on. `Read`: reads end. `Both`:
    /// both, and any reader waiting returns.
    pub fn shutdown(&self, how: Shutdown) -> io::Result<()> {
        if matches!(how, Shutdown::Read | Shutdown::Both) {
            self.0.read_shut.store(true, Ordering::SeqCst);
        }
        if matches!(how, Shutdown::Write | Shutdown::Both) {
            let mut core = self.lock()?;
            core.sockets.get_mut::<tcp::Socket>(self.0.socket).close();
            core.poll();
        }
        self.0.inner.moved.notify_all();
        Ok(())
    }

    fn lock(&self) -> io::Result<MutexGuard<'_, Core>> {
        if self.0.inner.stopped.load(Ordering::SeqCst) {
            return Err(stopped());
        }
        Ok(self.0.inner.core.lock_ok())
    }

    /// Wait for the thread to move something, until `deadline`; the lock
    /// back, or `WouldBlock` once it passed (a socket's timeout).
    fn wait<'a>(
        &'a self,
        core: MutexGuard<'a, Core>,
        deadline: Option<Deadline>,
    ) -> io::Result<MutexGuard<'a, Core>> {
        let left = match deadline {
            Some(d) if d.passed() => return Err(io::ErrorKind::WouldBlock.into()),
            Some(d) => d.remaining(),
            // No timeout: wait in slices, looking at the stop flag between.
            None => Duration::from_secs(1),
        };
        let core = self
            .0
            .inner
            .moved
            .wait_timeout(core, left)
            .map(|(g, _)| g)
            .unwrap_or_else(|p| p.into_inner().0);
        if self.0.inner.stopped.load(Ordering::SeqCst) {
            return Err(stopped());
        }
        Ok(core)
    }
}

impl Read for Stream {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let deadline = self.0.read_timeout.lock_ok().map(Deadline::after);
        let mut core = self.lock()?;
        loop {
            if self.0.read_shut.load(Ordering::SeqCst) {
                return Ok(0);
            }
            let s = core.sockets.get_mut::<tcp::Socket>(self.0.socket);
            if s.can_recv() {
                let n = s
                    .recv_slice(buf)
                    .map_err(|e| io::Error::other(e.to_string()))?;
                // The window opened: say so now.
                core.poll();
                return Ok(n);
            }
            if !s.may_recv() {
                // The peer said goodbye, or the connection is gone (a reset,
                // a timeout): the end, either way.
                return Ok(0);
            }
            core = self.wait(core, deadline)?;
        }
    }
}

impl Write for Stream {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        if buf.is_empty() {
            return Ok(0);
        }
        let deadline = self.0.write_timeout.lock_ok().map(Deadline::after);
        let mut core = self.lock()?;
        loop {
            let s = core.sockets.get_mut::<tcp::Socket>(self.0.socket);
            if !s.may_send() {
                return Err(io::ErrorKind::BrokenPipe.into());
            }
            if s.can_send() {
                let n = s
                    .send_slice(buf)
                    .map_err(|e| io::Error::other(e.to_string()))?;
                core.poll();
                return Ok(n);
            }
            core = self.wait(core, deadline)?;
        }
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}
