//! How the agent's processes and the app talk on the machine: the one
//! envelope (rpc.rs), framed as lines (jsonl.rs) within deadlines that do
//! not move (deadline.rs), through doors that know their callers (door.rs)
//! — the agent's own local socket (local/) and, on the controller, the
//! app's API (controller/api/).

pub mod deadline;
pub mod door;
pub mod jsonl;
pub mod local;
pub mod rpc;
