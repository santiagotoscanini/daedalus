//! Keeping the machine awake.
//!
//! Two lines of defence, both taken whenever the policy turns the hold on
//! (`agent_main`, lib.rs):
//!
//! 1. A power request, held until the policy turns it off or the process
//!    ends. On Windows that is
//!    `PowerCreateRequest` + `PowerSetRequest` with `PowerRequestSystemRequired`
//!    — what Windows itself uses and what `powercfg /requests` lists, with
//!    the reason string beside it. On macOS it is an IOKit power assertion
//!    (`PreventUserIdleSystemSleep`, the same one `caffeinate -i` takes),
//!    listed by `pmset -g assertions`. Either stops the idle timer from
//!    sleeping the machine. Neither stops a person choosing Sleep, closing a
//!    laptop's lid, or an OS update restart.
//! 2. On Windows, the active power plan's timeouts set to zero and
//!    hibernation turned off, through `powercfg`: if the service is ever
//!    stopped, the plan alone keeps the machine up. macOS has no second
//!    line here — `pmset` changes are the user's to make, and the assertion
//!    is what Apple's own tools use.
//!
//! The mechanisms are per OS (os/windows/power.rs, os/macos/power.rs). On
//! Linux, for now, `Hold::acquire` refuses and the rest report nothing, so
//! the rest of the agent can be run and tested there.
//!
//! - `Hold::acquire(reason)` takes the request — the reason is what
//!   `powercfg /requests` or `pmset -g assertions` shows — and dropping the
//!   `Hold` releases it;
//! - `converge_plan()` sets the plan so the machine never sleeps or
//!   hibernates on its own; it returns what it did, or None where there is
//!   nothing to do (everywhere but Windows);
//! - `requests_report()` is what the OS says is holding it awake right now
//!   — the proof, for the status page, that the hold is visible to the OS
//!   and not just to this process;
//! - `os_uptime_secs()` is the seconds since the machine booted, from the
//!   OS — distinct from the agent's own uptime, and the number that shows a
//!   scheduled restart.

pub use crate::os::{converge_plan, os_uptime_secs, requests_report, Hold};
