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
which is deliberately tiny: it rewrites exactly one line.

What it does
------------
Accepts a connection, reads the client's `AUTH EXTERNAL <hex-uid>` line,
substitutes the uid this process actually runs as, and from then on
forwards bytes verbatim in both directions.

Trust model: the socket is created 0600 and owned by the same user the
relay runs as, so the only processes that can reach it are ones already
running as that user — i.e. ones that could talk to the system bus
directly anyway. The relay grants no authority that was not already
available; it only makes the handshake agree with reality.

Known limitation
----------------
This forwards bytes, not file descriptors. `bleak` sets
negotiate_unix_fd=True when it CONNECTS to a device (backends/bluezdbus/
client.py), so GATT connections over this relay will not work. Adapter
enumeration and passive advertisement scanning do not negotiate fds, so
BLE sensors that broadcast (BTHome, Xiaomi/ATC thermometers) and
presence beacons are fine. If a device that needs an active connection
is ever wanted, the answer is an ESPHome Bluetooth proxy, not more code
here.
"""

import asyncio
import binascii
import os
import sys

UPSTREAM = sys.argv[1] if len(sys.argv) > 1 else "/run/dbus/system_bus_socket"
LISTEN = sys.argv[2] if len(sys.argv) > 2 else "/run/ha-dbus/bus"

# The uid the bus will actually see for our connection.
REAL_UID = os.getuid()
AUTH_LINE = b"AUTH EXTERNAL " + binascii.hexlify(str(REAL_UID).encode()) + b"\r\n"


async def _pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    """Forward until EOF, then half-close so the peer sees it."""
    try:
        while chunk := await reader.read(65536):
            writer.write(chunk)
            await writer.drain()
    except (ConnectionResetError, BrokenPipeError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def handle(client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter) -> None:
    try:
        up_r, up_w = await asyncio.open_unix_connection(UPSTREAM)
    except OSError as exc:
        print(f"upstream {UPSTREAM} unreachable: {exc}", flush=True)
        client_w.close()
        return

    try:
        # The client opens with a NUL byte, then its AUTH line. Read and
        # discard both; the NUL is a protocol marker, not credentials.
        if await client_r.readexactly(1) != b"\0":
            client_w.close()
            up_w.close()
            return
        await client_r.readuntil(b"\r\n")

        # Introduce ourselves upstream with a uid that matches
        # SO_PEERCRED. Everything after this is the client's own
        # conversation.
        up_w.write(b"\0" + AUTH_LINE)
        await up_w.drain()
    except (asyncio.IncompleteReadError, ConnectionResetError, OSError):
        client_w.close()
        up_w.close()
        return

    await asyncio.gather(
        _pump(up_r, client_w),
        _pump(client_r, up_w),
    )


async def main() -> None:
    if os.path.exists(LISTEN):
        os.unlink(LISTEN)
    os.makedirs(os.path.dirname(LISTEN), exist_ok=True)
    # 0600 before anything can connect: the umask covers the window
    # between bind() and chmod().
    os.umask(0o177)
    server = await asyncio.start_unix_server(handle, path=LISTEN)
    os.chmod(LISTEN, 0o600)
    print(f"relaying {LISTEN} -> {UPSTREAM} as uid {REAL_UID}", flush=True)
    async with server:
        await server.serve_forever()


asyncio.run(main())
