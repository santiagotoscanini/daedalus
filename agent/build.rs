//! Embeds the daedalus icon and the version block into both Windows
//! executables, so Explorer, Task Manager and the file's Properties dialog
//! show what they are. Skipped on every other target.

fn main() {
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
