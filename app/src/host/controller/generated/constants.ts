// Generated from agent/src (src/ts.rs). Do not edit: change the Rust type,
// then run agent/gate.sh gen.

/** The agent release this engine builds (Cargo.toml); the box's controller runs it, with the build's `+<id>`, once the engine is applied. */
export const AGENT_VERSION = '0.26.0'

/** The API version (api/mod.rs). */
export const API_VERSION = 1

/** The longest line either side writes, in bytes (ipc/door.rs). */
export const MAX_LINE = 1048576

/** How long the controller waits for a machine to acknowledge a verb it relays, in ms (controller/link/registry.rs). */
export const ACK_TIMEOUT_MS = 5000

/** How long a detached `root.run` may take to start before the controller answers, in ms (controller/api/mod.rs). */
export const ROOT_DETACH_WAIT_MS = 30000

/** The longest name `nodes.set_desired` takes, in characters (api/wire.rs). */
export const MAX_NODE_NAME = 64

/** The longest hostname a machine's hello carries, in bytes (link/wire.rs). */
export const MAX_HOSTNAME = 253

/** The port a lemonade answers on unless its policy names another (providers/lemonade.rs). */
export const LEMONADE_DEFAULT_PORT = 13305
