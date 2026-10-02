//! What both ways of replacing the agent share: a download kept only when it
//! is the manifest's, and the version a binary says it is. How the files are
//! put in place is the OS's: the binaries beside this one on Windows and
//! Linux (files.rs), the app bundle's one fixed place on macOS (bundle.rs).

use std::path::Path;

use anyhow::{bail, Context, Result};

use super::*;

/// `body` into `path`, at most `size` bytes, hashed as it goes, flushed to
/// disk; removed again unless it is exactly `size` bytes of `sha256`.
pub(super) fn store_verified(
    body: impl std::io::Read,
    path: &Path,
    size: u64,
    sha256: &[u8; 32],
) -> Result<()> {
    use sha2::Digest;
    use std::io::{Read, Write};
    let _ = std::fs::remove_file(path);
    let stored = (|| -> Result<()> {
        let mut f = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(path)
            .with_context(|| format!("creating {}", path.display()))?;
        let mut body = body.take(size + 1);
        let mut hash = sha2::Sha256::new();
        let mut buf = vec![0u8; 64 * 1024];
        let mut got = 0u64;
        loop {
            let n = body.read(&mut buf).context("reading the download")?;
            if n == 0 {
                break;
            }
            got += n as u64;
            if got > size {
                bail!("larger than the manifest's {size} bytes");
            }
            hash.update(&buf[..n]);
            f.write_all(&buf[..n]).context("writing the download")?;
        }
        if got != size {
            bail!("{got} bytes, not the manifest's {size}");
        }
        if hash.finalize().as_slice() != sha256 {
            bail!("its SHA-256 is not the manifest's");
        }
        f.sync_all().context("flushing the download")?;
        Ok(())
    })();
    if stored.is_err() {
        let _ = std::fs::remove_file(path);
    }
    stored
}

/// Download one release asset into `path` through `store_verified`.
pub(super) fn fetch_verified(rel: &Release, a: &Asset, path: &Path) -> Result<()> {
    tracing::info!(
        tag = rel.tag,
        asset = a.local_name,
        bytes = a.size,
        "downloading"
    );
    download_verified(&a.url, path, a.size, &a.sha256)
        .with_context(|| format!("{}: {}", rel.tag, a.local_name))?;
    tracing::info!(asset = a.local_name, "verified against the signed manifest");
    Ok(())
}

/// What the service binary at `exe` says it is (`<exe> version`), without
/// build metadata: the check that a file put in place — or about to be — is
/// the version the manifest named and runs on this machine at all.
pub(crate) fn version_of(exe: &Path) -> Result<semver::Version> {
    let mut cmd = std::process::Command::new(exe);
    cmd.arg("version");
    let out = crate::exec::stdout_or(
        cmd,
        std::time::Duration::from_secs(20),
        crate::exec::Text::Lossy,
    )
    .map_err(|e| anyhow::anyhow!("{} version: {e}", exe.display()))?;
    let v = out
        .split_whitespace()
        .nth(1)
        .with_context(|| format!("{} version said {out:?}", exe.display()))?;
    semver::Version::parse(v)
        .map(|v| release_version(&v))
        .with_context(|| format!("{} version said {out:?}", exe.display()))
}

/// `url` into `path` through `store_verified`, within ten minutes: what
/// the agent's own update and a provider's installer (providers/install.rs)
/// both download with.
pub(crate) fn download_verified(
    url: &str,
    path: &Path,
    size: u64,
    sha256: &[u8; 32],
) -> Result<()> {
    let resp = crate::http::agent()
        .get(url)
        .timeout(std::time::Duration::from_secs(600))
        .call()
        .with_context(|| format!("downloading {url}"))?;
    store_verified(resp.into_reader(), path, size, sha256)
}
