"""Relay the D-Bus system bus into a rootless container, fixing the uid.

Why this exists
---------------
D-Bus EXTERNAL authentication compares the uid a client CLAIMS against
the uid the kernel reports via SO_PEERCRED. Home Assistant runs as
container-root, so it claims uid 0; rootless podman maps that to
santiago, so the bus sees 1000. The bus rejects the mismatch and the
Bluetooth integration never reaches BlueZ.

Measured, not assumed: over the very same socket, claiming 1000 returns
OK and claiming 0 returns REJECTED. Nothing about the mount, the policy
or the permissions is wrong — only the number in the handshake.

xdg-dbus-proxy does NOT solve this; it validates SO_PEERCRED the same
way and rejects the container identically (tested). Hence this relay,
which rewrites exactly one line and is otherwise transparent.

Why it forwards file descriptors
--------------------------------
BlueZ hands out a file descriptor for GATT characteristic notifications
(AcquireNotify/AcquireWrite), so bleak opens its connection with
negotiate_unix_fd=True whenever it CONNECTS to a device. A byte-only
relay breaks that, and it breaks it badly: dbus-fast does not fall back
if the negotiation is refused, it raises AuthError (auth.py
_receive_line — anything other than AGREE_UNIX_FD falls through to
`raise`). So refusing fds is not an option; they have to be passed
through with SCM_RIGHTS.

Without this, passive advertisement scanning works and every
connection-based device (Ember mug, most BLE thermostats/locks) fails.

Trust model
-----------
The socket is 0600 and owned by the user this relay runs as, so the only
processes that can reach it are ones already running as that user — ones
that could talk to the system bus directly anyway. The relay grants no
authority that was not already available; it makes the handshake agree
with reality and nothing else.

Threads, not asyncio: ancillary data needs recvmsg/sendmsg, which
asyncio's stream API does not expose. Two blocking threads per
connection is simpler and the connection count here is tiny (Home
Assistant opens a couple of bus connections, not thousands).
"""

import array
import binascii
import os
import socket
import sys
import threading

UPSTREAM = sys.argv[1] if len(sys.argv) > 1 else "/run/dbus/system_bus_socket"
LISTEN = sys.argv[2] if len(sys.argv) > 2 else "/run/ha-dbus/bus"

REAL_UID = os.getuid()
AUTH_LINE = b"\0AUTH EXTERNAL " + binascii.hexlify(str(REAL_UID).encode()) + b"\r\n"

BUF = 65536
# D-Bus caps a message at 16 descriptors; leave headroom.
MAX_FDS = 64
ANC_SIZE = socket.CMSG_SPACE(MAX_FDS * array.array("i").itemsize)


def _consume_client_auth(sock: socket.socket) -> bool:
    """Read the client's opening NUL + AUTH line and throw them away.

    Byte-at-a-time is fine: this is one short line, exactly once per
    connection, before any real traffic.
    """
    if sock.recv(1) != b"\0":
        return False
    line = b""
    while not line.endswith(b"\r\n"):
        byte = sock.recv(1)
        if not byte:
            return False
        line += byte
    return True


def _pump(src: socket.socket, dst: socket.socket) -> None:
    """Forward data AND any passed file descriptors until EOF."""
    while True:
        try:
            data, ancdata, _flags, _addr = src.recvmsg(BUF, ANC_SIZE)
        except OSError:
            break
        if not data:
            break

        fds: list[int] = []
        for level, msg_type, cmsg in ancdata:
            if level == socket.SOL_SOCKET and msg_type == socket.SCM_RIGHTS:
                arr = array.array("i")
                # Truncate to a whole number of ints; a partial trailing
                # fd would be garbage.
                arr.frombytes(cmsg[: len(cmsg) - (len(cmsg) % arr.itemsize)])
                fds.extend(arr)

        try:
            if fds:
                sent = dst.sendmsg(
                    [data],
                    [(socket.SOL_SOCKET, socket.SCM_RIGHTS, array.array("i", fds))],
                )
                # Descriptors ride with the first byte; the remainder is
                # ordinary data.
                if sent < len(data):
                    dst.sendall(data[sent:])
            else:
                dst.sendall(data)
        except OSError:
            break
        finally:
            # We hold duplicates of every fd we received; the far side
            # has its own copies now.
            for fd in fds:
                try:
                    os.close(fd)
                except OSError:
                    pass

    # Let the peer see the close rather than hanging on a half-open pair.
    for sock in (src, dst):
        try:
            sock.shutdown(socket.SHUT_RDWR)
        except OSError:
            pass


def handle(client: socket.socket) -> None:
    upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        upstream.connect(UPSTREAM)
    except OSError as exc:
        print(f"upstream {UPSTREAM} unreachable: {exc}", flush=True)
        client.close()
        return

    try:
        if not _consume_client_auth(client):
            raise OSError("client closed during auth")
        # Introduce ourselves with a uid that matches SO_PEERCRED.
        upstream.sendall(AUTH_LINE)
    except OSError:
        client.close()
        upstream.close()
        return

    threading.Thread(target=_pump, args=(upstream, client), daemon=True).start()
    _pump(client, upstream)
    client.close()
    upstream.close()


def main() -> None:
    if os.path.exists(LISTEN):
        os.unlink(LISTEN)
    os.makedirs(os.path.dirname(LISTEN), exist_ok=True)
    # 0600 from the moment it exists — the umask covers the gap between
    # bind() and chmod().
    os.umask(0o177)
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(LISTEN)
    os.chmod(LISTEN, 0o600)
    server.listen(16)
    print(f"relaying {LISTEN} -> {UPSTREAM} as uid {REAL_UID} (fd-passing)", flush=True)

    while True:
        conn, _ = server.accept()
        threading.Thread(target=handle, args=(conn,), daemon=True).start()


main()
