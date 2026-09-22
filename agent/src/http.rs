//! The one HTTPS client, built on the OS's TLS through native-tls: SChannel
//! on Windows, Security.framework on macOS, OpenSSL elsewhere. So the
//! machine's own trust store is what decides whether the box's certificate
//! (Let's Encrypt, today) and GitHub's are believed — and no C crypto
//! library has to be built for a target to check the code for it.

use std::sync::{Arc, OnceLock};

/// A shared agent: one connection pool, one TLS configuration.
pub fn agent() -> ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            let tls = native_tls::TlsConnector::new().expect("the OS TLS stack initialises");
            ureq::AgentBuilder::new()
                .tls_connector(Arc::new(tls))
                .user_agent(concat!("daedalus-agent/", env!("CARGO_PKG_VERSION")))
                .build()
        })
        .clone()
}
