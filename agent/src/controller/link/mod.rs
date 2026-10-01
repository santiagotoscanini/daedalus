//! The controller's side of the link: the listener the machines dial, one
//! thread per connection, and the `Registry` — what the controller knows
//! about every machine, which the local API reads (api/, `nodes.*`) and
//! `/nodes/metrics` renders.
//!
//! **Observed and desired.** The registry holds OBSERVED state in memory
//! only — per machine the last hello, status document, telemetry, Claude
//! report and providers, when it connected and when it was last heard —
//! and nothing on disk: after a restart the machines reconnect and fill
//! it again. DESIRED state is the app's: `nodes.set_desired` hands over
//! the complete set of decided keys with their standing (approved or
//! revoked) and policies, and the registry applies the difference to the
//! connections open now (`set_desired`). A key outside that set is
//! PENDING while connected and UNKNOWN once it leaves; of an unknown key
//! only its id, fingerprint, hostname and when it was last seen are kept.
//! A decision is for one KEY: an id the app decided for another key (two
//! keys sharing sixteen hex characters) is neither approved nor revoked
//! for this one, and is refused.
//!
//! **A connection** (`serve_connection`), before admission: a PRE-AUTH
//! slot, `PREAUTH_BUDGET` for the TLS handshake (the machine's key proved,
//! tls.rs) and the first line — `hello`, at most `MAX_HELLO_LINE` bytes, of
//! protocol `PROTO` (another gets a `version` error naming this one), with
//! the node id of the key the handshake proved and fields within
//! `Hello::check`'s bounds. Then the key's standing: revoked is told so and
//! closed; unknown is counted against its address's `UNKNOWN_PER_MINUTE`
//! and admitted PENDING — restricted: listed for the app,
//! heartbeats flow, nothing it pushes is kept — within
//! `MAX_PENDING` and `PENDING_PER_IP`; approved gets its policy in the
//! answer and any commands queued for it. A second connection with the same
//! key replaces the first. From then on the thread interleaves the
//! machine's lines with its outgoing queue every `TICK`, sends a heartbeat
//! every `HEARTBEAT`, gives up after `DEAD_AFTER` of silence, and closes a
//! connection pending past `PENDING_TTL`.
//!
//! **Why the pools.** Anyone on the LAN can open a TCP connection, so what
//! a connection can hold before it has proved an approved key is bounded
//! apart from what admitted machines hold: `MAX_PREAUTH` pre-auth slots in
//! all and `PREAUTH_PER_IP` per address (an IPv6 /64 is one address), each
//! released at admission or after `PREAUTH_BUDGET`; `MAX_CONNECTIONS`
//! admitted. The unknown-key rate is judged after the handshake, from the
//! key, so an approved machine is never refused for sharing an address; and
//! when the admitted pool is full an approved key takes the place of the
//! oldest pending one. The addresses counted are at most
//! `UNKNOWN_ADDRESSES` (the least recently seen go), and at most
//! `MAX_FORGOTTEN` keys that are neither decided nor connected are
//! remembered.
//!
//! **Commands** (`command`): delivered at once to a connected, approved
//! machine and acknowledged by it within `ACK_TIMEOUT`; queued, one of each
//! kind, for an approved machine that is not connected, and delivered when
//! it next connects.
//!
//! **Session verbs** (`claude_session`): one verb on one of a machine's
//! Claude sessions, delivered only to a connected, approved machine that
//! offers `claude.sessions` and acknowledged within `ACK_TIMEOUT` — never
//! queued, since a resume that fires whenever the machine next connects is
//! one nobody asked for then. The outcome rides the machine's next
//! `claude_roster` push, under the request id minted here.
//!
//! **Settings asked for by a machine** (`policy_request`, registry.rs):
//! an approved machine's user may ask for its keep-awake, Claude Remote
//! Control and santree OFF — never santree on, which grants a shell on the
//! box and is an admin's, in the browser. The request is checked, counted
//! against `POLICY_REQUESTS_PER_MINUTE`, and handed to the app as
//! `nodes.policy_request`; the app writes it and sends the set again, and
//! that set is the only thing that changes the machine. No subscriber
//! queue took the event: refused `unavailable`, the app is not listening.
//!
//! **santree** (session_host.rs): a machine's policy carries the session
//! host's address and key while the app turns santree on for it
//! (registry.rs `effective`), and the host's allow-list is written from each
//! desired set before its policy events go out, one set at a time.

mod accept;
mod registry;

pub use accept::*;
pub use registry::*;

#[cfg(test)]
mod tests;
