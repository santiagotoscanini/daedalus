//! The controller: the agent on the box, built with the `controller`
//! feature (a node's binary carries none of this). The app's door (controller/api/),
//! the listener and registry of the machines' links (link/) under keys it
//! can rotate (rotation.rs), the session host it follows
//! (session_host.rs), the relay to the root helper and the helper itself
//! (root/), and the metrics page Prometheus scrapes (metrics_page.rs).

pub mod api;
pub mod link;
pub mod metrics_page;
pub mod root;
pub mod rotation;
pub mod session_host;
