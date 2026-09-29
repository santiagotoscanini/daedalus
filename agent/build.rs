//! Two things at build time. The version the binary reports: the crate's,
//! and for a build that is not a release — the box's, which nix names by the
//! hash of the source it builds — `+<id>` after it (`DAEDALUS_BUILD_ID`), so
//! two different binaries never report the same version (agent/README.md
//! "Versions"). And on Windows, the daedalus icon and the version block in
//! both executables, so Explorer, Task Manager and the file's Properties
//! dialog show what they are.

fn main() {
    println!("cargo:rerun-if-env-changed=DAEDALUS_BUILD_ID");
    let version = std::env::var("CARGO_PKG_VERSION").unwrap_or_default();
    let id = std::env::var("DAEDALUS_BUILD_ID")
        .unwrap_or_default()
        .trim()
        .to_string();
    // Semver build metadata: dot-separated, non-empty identifiers of
    // letters, digits and '-'.
    let valid = id.split('.').all(|part| {
        !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
    });
    let version = if id.is_empty() {
        version
    } else if valid {
        format!("{version}+{id}")
    } else {
        panic!("DAEDALUS_BUILD_ID is {id:?}: dot-separated letters, digits and '-' only");
    };
    println!("cargo:rustc-env=DAEDALUS_VERSION={version}");

    println!("cargo:rerun-if-changed=assets/icon.ico");
    if std::env::var("CARGO_CFG_TARGET_OS").as_deref() == Ok("windows") {
        let mut res = winresource::WindowsResource::new();
        res.set_icon("assets/icon.ico");
        res.set("ProductName", "Daedalus Agent");
        res.set("FileDescription", "Daedalus Agent");
        res.set("CompanyName", "daedalus");
        res.set("LegalCopyright", "MIT");
        if let Err(e) = res.compile() {
            println!("cargo:warning=resource not embedded: {e}");
        }
    }
}
