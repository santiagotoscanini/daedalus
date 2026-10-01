//! What a machine runs to be one of the box's: the link to the controller
//! (link.rs), a log-in (enroll.rs) or a pairing (pair.rs), its own tunnel
//! (tunnel/), the awake hold (power.rs), the settings it may ask for
//! (settings.rs), the providers it reads (providers/), santree's door
//! (santree.rs) and its own updates (update/).

// Logging in to the box for a tunnel of this machine's own (tunnel/).
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod enroll;
pub mod link;
pub mod pair;
pub mod power;
pub mod providers;
#[cfg(unix)]
pub mod santree;
pub mod settings;
// The machine's own WireGuard tunnel to the box (macOS and Linux: none on
// Windows in this version).
#[cfg(any(target_os = "macos", target_os = "linux"))]
pub mod tunnel;
pub mod update;
