#!/usr/bin/env python3
"""Ship Lemonade's log stream (gaming PC) into Loki.

Lemonade exposes exactly one log egress: a WebSocket at /logs/stream.
Its OTLP telemetry carries traces only, it has no syslog/OTLP-logs
exporter, and its log FILE lives on the Windows box where nothing here
can tail it. So this bridge is the only way those logs reach Loki.

Protocol (verified against Lemonade 10.8.1):

  -> {"type":"logs.subscribe","after_seq":<int|null>}
  <- {"type":"logs.snapshot","entries":[<entry>,...]}   once, on subscribe
  <- {"type":"logs.entry","entry":<entry>}              live, thereafter

  entry = {"seq":int, "timestamp":"YYYY-MM-DD HH:MM:SS.mmm",
           "severity":"Trace|Debug|Info|Warning|Error|Fatal",
           "tag":"Server|Process|Telemetry|WebSocket|...", "line":str}

`seq` is monotonic and `after_seq` resumes from it, so a reconnect costs
nothing and duplicates nothing. Subscribing with null instead replays the
server's whole 5000-entry ring — hence the persisted cursor.

That ring is also the durability limit: 5000 entries is roughly ONE busy
day. If this bridge stays down longer the oldest entries are gone for
good, and the only honest thing to do is say so — see the gap check in
session(). It is deliberately a warning in the log rather than a silent
resume, because silence here is indistinguishable from "nothing happened".

Stdlib only, no pip: the image is stock python:alpine with this file
bind-mounted. The WebSocket client below exists because the stdlib has no
client and one dependency is not worth a built image.

This bridge's OWN stdout goes to journald like every other container, so
alloy ships it under stack=lemonade-logs (the documented fallback in
stacks/logging), keeping the bridge's diagnostics separate from the
remote server's logs it pushes under stack=lemonade.
"""

import base64
import json
import os
import select
import socket
import struct
import time
import urllib.request
from datetime import datetime

HOST = os.environ.get("LEMONADE_HOST", "gaming-pc.local.toscanini.me")
PORT = int(os.environ.get("LEMONADE_PORT", "13305"))
LOKI_URL = os.environ.get("LOKI_URL", "http://loki:3100/loki/api/v1/push")
CURSOR_FILE = os.environ.get("CURSOR_FILE", "/var/lib/lemonade-logs/cursor")
LABEL_STACK = os.environ.get("LABEL_STACK", "lemonade")
LABEL_HOST = os.environ.get("LABEL_HOST", "gaming-pc")
# Loki derives service_name from a container-ish label it cannot find on a
# pushed stream, and falls back to "unknown_service" — which is the key
# Grafana's Logs Drilldown groups by. Set it explicitly.
LABEL_SERVICE = os.environ.get("LABEL_SERVICE", "lemonade")

BATCH = 500  # entries per Loki push; the 5000-entry backfill is 10 of these
FLUSH_S = 2.0  # max time an entry waits before being pushed
READ_TIMEOUT_S = 60.0  # a half-read message stalled this long = dead peer
PING_IDLE_S = 120.0  # silence before probing the connection
BACKOFF_MIN_S = 5
BACKOFF_MAX_S = 300
SESSION_OK_S = 60  # a session alive this long resets the backoff

# Lemonade's vocabulary folded onto the one stacks/logging already uses,
# so `level` means the same thing here as on every other stack.
SEVERITY = {
    "trace": "debug",
    "debug": "debug",
    "info": "info",
    "notice": "info",
    "warning": "warning",
    "warn": "warning",
    "error": "error",
    "err": "error",
    "fatal": "crit",
    "critical": "crit",
    "crit": "crit",
}


def log(level, msg):
    """Emit our own diagnostics in a shape alloy's level regex reads."""
    print(f"{datetime.now().isoformat(timespec='seconds')} [{level}] {msg}")


class WebSocket:
    """Minimal RFC 6455 client: text messages, fragmentation, ping/pong."""

    def __init__(self, host, port, path):
        self.sock = socket.create_connection((host, port), timeout=30)
        self.sock.setsockopt(socket.SOL_SOCKET, socket.SO_KEEPALIVE, 1)
        key = base64.b64encode(os.urandom(16)).decode()
        self.sock.sendall(
            (
                f"GET {path} HTTP/1.1\r\n"
                f"Host: {host}:{port}\r\n"
                f"Upgrade: websocket\r\n"
                f"Connection: Upgrade\r\n"
                f"Sec-WebSocket-Key: {key}\r\n"
                f"Sec-WebSocket-Version: 13\r\n\r\n"
            ).encode()
        )
        self.buf = b""
        while b"\r\n\r\n" not in self.buf:
            chunk = self.sock.recv(4096)
            if not chunk:
                raise ConnectionError("peer closed during handshake")
            self.buf += chunk
        head, self.buf = self.buf.split(b"\r\n\r\n", 1)
        status = head.split(b"\r\n", 1)[0].decode(errors="replace")
        if " 101" not in status:
            raise ConnectionError(f"upgrade refused: {status}")
        self.sock.settimeout(READ_TIMEOUT_S)

    def _recv_exact(self, n):
        # Only ever appends to self.buf and consumes once n bytes are
        # present, so a timeout cannot leave a frame half-consumed.
        while len(self.buf) < n:
            chunk = self.sock.recv(65536)
            if not chunk:
                raise ConnectionError("peer closed")
            self.buf += chunk
        out, self.buf = self.buf[:n], self.buf[n:]
        return out

    def _send(self, opcode, data=b""):
        mask = os.urandom(4)
        masked = bytes(b ^ mask[i % 4] for i, b in enumerate(data))
        n = len(data)
        if n < 126:
            hdr = struct.pack("!BB", 0x80 | opcode, 0x80 | n)
        elif n < 65536:
            hdr = struct.pack("!BBH", 0x80 | opcode, 0x80 | 126, n)
        else:
            hdr = struct.pack("!BBQ", 0x80 | opcode, 0x80 | 127, n)
        self.sock.sendall(hdr + mask + masked)

    def send_text(self, text):
        self._send(0x1, text.encode())

    def ping(self):
        self._send(0x9)

    def _read_frame(self):
        b0, b1 = self._recv_exact(2)
        if b1 & 0x80:
            raise ConnectionError("server frame must not be masked")
        length = b1 & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(8))[0]
        return bool(b0 & 0x80), b0 & 0x0F, self._recv_exact(length)

    def recv_text(self):
        """Next complete text message. Control frames handled inline."""
        data = b""
        is_text = False
        while True:
            fin, opcode, payload = self._read_frame()
            if opcode == 0x8:
                raise ConnectionError("server sent close")
            if opcode == 0x9:
                self._send(0xA, payload)
                continue
            if opcode == 0xA:
                continue
            if opcode in (0x1, 0x2):
                is_text, data = opcode == 0x1, payload
            elif opcode == 0x0:
                data += payload
            if fin:
                if is_text:
                    return data.decode("utf-8", "replace")
                data, is_text = b"", False


def read_cursor():
    try:
        with open(CURSOR_FILE) as fh:
            return int(fh.read().strip())
    except (FileNotFoundError, ValueError):
        return None


def write_cursor(seq):
    tmp = f"{CURSOR_FILE}.tmp"
    with open(tmp, "w") as fh:
        fh.write(str(seq))
    os.replace(tmp, CURSOR_FILE)  # atomic: a torn write would replay the ring


def to_unix_nanos(stamp):
    """Lemonade stamps local wall-clock with no offset. The container's TZ
    is the host's (mkRootlessContainer injects it) and zoneinfo is mounted,
    so strptime+timestamp() resolves it correctly."""
    try:
        parsed = datetime.strptime(stamp, "%Y-%m-%d %H:%M:%S.%f")
    except (TypeError, ValueError):
        return time.time_ns()
    # Built from whole seconds + micros rather than float math: a float
    # nanosecond count past 2001 has already lost sub-microsecond bits.
    return int(parsed.timestamp()) * 1_000_000_000 + parsed.microsecond * 1000


def push(entries):
    """POST to Loki, one stream per (level, tag). Raises on failure so the
    caller can retry without advancing the cursor."""
    streams = {}
    for entry in entries:
        # Backend subprocess output arrives with Windows CRLF endings.
        line = (entry.get("line") or "").rstrip("\r\n")
        if not line:
            continue
        level = SEVERITY.get(str(entry.get("severity", "")).lower(), "unknown")
        tag = str(entry.get("tag") or "none")
        streams.setdefault((level, tag), []).append(
            [str(to_unix_nanos(entry.get("timestamp"))), line]
        )
    if not streams:
        return
    body = json.dumps(
        {
            "streams": [
                {
                    "stream": {
                        "stack": LABEL_STACK,
                        "service_name": LABEL_SERVICE,
                        "host": LABEL_HOST,
                        "level": level,
                        "tag": tag,
                    },
                    "values": sorted(values, key=lambda v: int(v[0])),
                }
                for (level, tag), values in streams.items()
            ]
        }
    ).encode()
    request = urllib.request.Request(
        LOKI_URL,
        data=body,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=30) as response:
        response.read()


def session():
    """One connection's lifetime. Returns only by raising."""
    cursor = read_cursor()
    ws = WebSocket(HOST, PORT, "/logs/stream")
    ws.send_text(json.dumps({"type": "logs.subscribe", "after_seq": cursor}))
    log("info", f"subscribed to {HOST}:{PORT}/logs/stream after_seq={cursor}")

    pending = []
    last_flush = last_rx = time.monotonic()

    while True:
        # Zero timeout once a full batch is queued so the 5000-entry
        # backfill drains in a tight loop instead of 2s per chunk.
        timeout = 0 if len(pending) >= BATCH else FLUSH_S
        if ws.buf or select.select([ws.sock], [], [], timeout)[0]:
            message = json.loads(ws.recv_text())
            last_rx = time.monotonic()
            kind = message.get("type")
            if kind == "logs.snapshot":
                entries = message.get("entries") or []
                if entries and cursor is not None:
                    first = entries[0].get("seq")
                    if isinstance(first, int) and first > cursor + 1:
                        lost = first - cursor - 1
                        log(
                            "warning",
                            f"log gap: {lost} entries (seq {cursor + 1}..{first - 1}) "
                            "aged out of Lemonade's 5000-entry ring while this "
                            "bridge was down; they are unrecoverable",
                        )
                    # Defensive: after_seq should already exclude these.
                    entries = [
                        e
                        for e in entries
                        if not isinstance(e.get("seq"), int) or e["seq"] > cursor
                    ]
                log("info", f"snapshot: {len(entries)} entries to backfill")
                pending.extend(entries)
            elif kind == "logs.entry":
                entry = message.get("entry")
                if entry:
                    pending.append(entry)

        now = time.monotonic()
        if pending and (len(pending) >= BATCH or now - last_flush >= FLUSH_S):
            chunk = pending[:BATCH]
            push(chunk)  # raises -> reconnect; chunk stays queued, cursor stays put
            del pending[: len(chunk)]
            seqs = [e["seq"] for e in chunk if isinstance(e.get("seq"), int)]
            if seqs:
                cursor = max(seqs)
                write_cursor(cursor)
            last_flush = now
        elif now - last_rx >= PING_IDLE_S:
            # Lemonade is often silent for hours. Probe so a dead peer
            # surfaces as a send error instead of an indefinite wait.
            ws.ping()
            last_rx = now


def main():
    backoff = BACKOFF_MIN_S
    while True:
        started = time.monotonic()
        try:
            session()
        except Exception as exc:
            alive = time.monotonic() - started
            if alive >= SESSION_OK_S:
                backoff = BACKOFF_MIN_S
            log(
                "error",
                f"session ended after {alive:.0f}s: "
                f"{type(exc).__name__}: {exc}; reconnecting in {backoff}s",
            )
            time.sleep(backoff)
            backoff = min(backoff * 2, BACKOFF_MAX_S)


if __name__ == "__main__":
    main()
