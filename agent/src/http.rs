//! The one HTTPS client. On Windows and macOS it is built on the OS's TLS
//! through native-tls — SChannel, Security.framework — so the machine's own
//! trust store decides whether the box's certificate (Let's Encrypt, today)
//! and GitHub's are believed, and no C crypto library has to be built for a
//! target to check the code for it. On Linux it is rustls with the
//! system's CA bundle, so one static binary runs on every distribution
//! without its OpenSSL (`os::tls`).

use std::sync::OnceLock;

/// What every request says it is: this build's version (`crate::VERSION`).
pub const USER_AGENT: &str = concat!("daedalus-agent/", env!("DAEDALUS_VERSION"));

/// A shared agent: one connection pool, one TLS configuration.
pub fn agent() -> ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            crate::os::tls(ureq::AgentBuilder::new())
                .user_agent(USER_AGENT)
                .build()
        })
        .clone()
}
