//! The feed, the manifest, the swap and probation, on files and pure state.
//! The file strategy's tests are Windows' and Linux's (a Mac replaces its
//! app bundle whole: slot.rs, os/macos/bundle.rs).

#[cfg(not(target_os = "macos"))]
use std::path::Path;

use ed25519_dalek::{Signer, SigningKey};

use super::*;

#[test]
fn the_compiled_in_keys_parse() {
    assert!(!verifying_keys()
        .expect("every listed key is an ed25519 key")
        .is_empty());
}

/// A manifest signed as CI signs it: the context, then the bytes.
fn signed(key: &SigningKey, manifest: &[u8]) -> Vec<u8> {
    let mut m = MANIFEST_CONTEXT.to_vec();
    m.extend_from_slice(manifest);
    key.sign(&m).to_bytes().to_vec()
}

#[test]
fn a_manifest_holds_only_under_a_listed_key_and_its_own_context() {
    let key = SigningKey::from_bytes(&[7; 32]);
    let other = SigningKey::from_bytes(&[8; 32]);
    let keys = [other.verifying_key(), key.verifying_key()];
    let body = br#"{"product":"daedalus-agent"}"#;
    // Any listed key: the spare as much as the current one.
    verify_manifest(body, &signed(&key, body), &keys).unwrap();
    // Not listed.
    assert!(verify_manifest(body, &signed(&key, body), &keys[..1]).is_err());
    // Tampered, or a signature over the bytes alone (the per-asset scheme).
    assert!(verify_manifest(b"{}", &signed(&key, body), &keys).is_err());
    let bare = key.sign(body).to_bytes();
    assert!(verify_manifest(body, &bare, &keys).is_err());
    assert!(verify_manifest(body, &[0u8; 10], &keys).is_err());
}

#[cfg(not(target_os = "macos"))]
#[test]
fn an_old_binary_in_use_is_moved_aside_and_retired_later() {
    let old = Path::new("C:/x/daedalus-agent.exe.old");
    let taken = [
        "C:/x/daedalus-agent.exe.old.1",
        "C:/x/daedalus-agent.exe.old.2",
    ];
    let aside = free_aside(old, |p| taken.iter().any(|t| Path::new(t) == p));
    assert!(aside.ends_with("daedalus-agent.exe.old.3"));
    for yes in [
        "daedalus-agent.exe.old",
        "daedalus-agent.exe.old.1",
        "daedalus-agent.exe.old.12",
    ] {
        assert!(is_retired("daedalus-agent.exe", yes), "{yes}");
    }
    for no in [
        "daedalus-agent.exe",
        "daedalus-agent.exe.new",
        "daedalus-agent.exe.old.",
        "daedalus-agent.exe.old.x",
        "daedalus-agent.exe.older",
        "daedalus-agent-tray.exe.old",
    ] {
        assert!(!is_retired("daedalus-agent.exe", no), "{no}");
    }
}

#[cfg(not(target_os = "macos"))]
#[test]
fn suffixed_names() {
    let p = suffixed(Path::new("C:/x/daedalus-agent.exe"), "old");
    assert!(p.ends_with("daedalus-agent.exe.old"));
}

/// A manifest signed as CI signs it — `openssl pkeyutl -sign -rawin` over
/// the context and the bytes, with a throwaway key made for this test —
/// holds here: the two ends agree on the message.
#[test]
fn a_manifest_signed_by_openssl_holds() {
    let key = ed25519_dalek::VerifyingKey::from_bytes(
        &hex::decode("b91d1361995d23ad28acac8a269de16aafa6caf1ecbdc259b422b395c9fa0ea5")
            .unwrap()
            .try_into()
            .unwrap(),
    )
    .unwrap();
    let sig = hex::decode(
        "4da6bb22139ae410e336c889f5bceb1853ae69676cc3cbc6300fa57b91f1aabb\
         bbfbe4d3c2fcf0609132ec08b8f8c3fd6042dfb81e6eda139fa5ba77aceca20c",
    )
    .unwrap();
    verify_manifest(br#"{"product":"daedalus-agent"}"#, &sig, &[key]).unwrap();
}

#[test]
fn every_asset_has_a_target_and_a_local_name() {
    for (target, remote, local) in ASSETS.iter().chain(OPTIONAL_ASSETS) {
        assert!(!target.is_empty() && !remote.is_empty() && !local.is_empty());
        assert!(remote.contains(target), "{remote} is named for {target}");
        assert!(!local.contains('/') && !local.contains('\\'));
    }
}

/// The manifest CI writes for a release of `version`, carrying this
/// target's assets (`optional` too, when asked), each of `bytes`.
fn manifest(version: &str, optional: bool, bytes: &[u8]) -> Manifest {
    use sha2::Digest;
    let sha = hex::encode(sha2::Sha256::digest(bytes));
    let entries = ASSETS
        .iter()
        .chain(if optional { OPTIONAL_ASSETS } else { &[] })
        .map(|(target, name, local)| ManifestAsset {
            target: target.to_string(),
            role: role_of(local).into(),
            name: name.to_string(),
            sha256: sha.clone(),
            size: bytes.len() as u64,
        })
        .collect();
    Manifest {
        product: PRODUCT.into(),
        version: version.into(),
        tag: format!("agent-v{version}"),
        assets: entries,
    }
}

/// The release GitHub lists for `m`: its tag and every file it names.
fn listed(m: &Manifest) -> ApiRelease {
    ApiRelease {
        tag_name: m.tag.clone(),
        draft: false,
        prerelease: false,
        assets: m
            .assets
            .iter()
            .map(|a| a.name.clone())
            .chain([MANIFEST.into(), MANIFEST_SIG.into()])
            .map(|n| ApiAsset {
                browser_download_url: format!("https://x/{n}"),
                name: n,
            })
            .collect(),
    }
}

#[test]
fn the_manifest_decides_the_version_the_target_and_the_files() {
    let running = semver::Version::parse("0.20.0").unwrap();
    let pick = |m: &Manifest, r: &ApiRelease, installed: bool| {
        assets_of(m, r, &running, None, |_| installed)
    };
    let m = manifest("0.21.0", true, b"bin");
    // Everything there, the optional ones installed: all of them, sized
    // and hashed as the manifest says.
    let (v, got) = pick(&m, &listed(&m), true).unwrap();
    assert_eq!(v.to_string(), "0.21.0");
    assert_eq!(got.len(), ASSETS.len() + OPTIONAL_ASSETS.len());
    assert!(got
        .iter()
        .all(|a| a.size == 3 && a.url.starts_with("https://x/")));
    // Not installed here: only the required ones.
    assert_eq!(pick(&m, &listed(&m), false).unwrap().1.len(), ASSETS.len());
    // Listed under another tag than it says (an old release re-published
    // as a new one), or a version that is not its tag's.
    let r = ApiRelease {
        tag_name: "agent-v99.0.0".into(),
        ..listed(&m)
    };
    assert!(pick(&m, &r, false).is_err());
    let wrong = Manifest {
        version: "0.22.0".into(),
        ..m.clone()
    };
    assert!(pick(&wrong, &listed(&wrong), false).is_err());
    let built = Manifest {
        version: "0.21.0+g1234567".into(),
        tag: "agent-v0.21.0+g1234567".into(),
        ..m.clone()
    };
    assert!(pick(&built, &listed(&built), false).is_err());
    // Not newer, or rolled back from.
    let old = manifest("0.20.0", false, b"bin");
    assert!(pick(&old, &listed(&old), false).is_err());
    let refused = semver::Version::parse("0.21.0").unwrap();
    assert!(assets_of(&m, &listed(&m), &running, Some(&refused), |_| false).is_err());
    // Another product's manifest.
    let theirs = Manifest {
        product: "santree".into(),
        ..m.clone()
    };
    assert!(pick(&theirs, &listed(&theirs), false).is_err());
    // Another target's binary under this one's name: not this target's.
    let mut swapped = m.clone();
    for a in &mut swapped.assets {
        a.target = "x86_64-unknown-freebsd".into();
    }
    assert!(pick(&swapped, &listed(&swapped), false).is_err());
    // A file the manifest names that the release does not carry.
    let mut short = listed(&m);
    short.assets.retain(|a| a.name != ASSETS[0].1);
    assert!(pick(&m, &short, false).is_err());
    // A hash that is not one.
    let mut bad = m.clone();
    bad.assets[0].sha256 = "zz".into();
    assert!(pick(&bad, &listed(&bad), false).is_err());
    // Unknown fields are refused: the manifest is a contract.
    assert!(serde_json::from_str::<Manifest>(
        r#"{"product":"daedalus-agent","version":"1.0.0","tag":"agent-v1.0.0","assets":[],"x":1}"#
    )
    .is_err());
}

/// The macOS app bundle's entry, as 0.24's manifest carries it.
fn bundle_entry() -> ManifestAsset {
    ManifestAsset {
        target: "universal-apple-darwin".into(),
        role: ROLE_BUNDLE.into(),
        name: "daedalus-agent-universal-apple-darwin.app.zip".into(),
        sha256: "ab".repeat(32),
        size: 1234,
    }
}

/// A 0.24-shaped manifest: the Mac's bundle and its DMG, no bare macOS
/// binaries — and this target's own entries only when `bare`.
fn bundled(version: &str, bare: bool) -> Manifest {
    let mut m = manifest(version, true, b"bin");
    if !bare {
        m.assets.clear();
    }
    m.assets.push(bundle_entry());
    m.assets.push(ManifestAsset {
        target: "universal-apple-darwin".into(),
        role: "installer".into(),
        name: "daedalus-agent-macos.dmg".into(),
        sha256: "cd".repeat(32),
        size: 99,
    });
    m
}

const MAC: &[&str] = &["universal-apple-darwin"];

#[test]
fn a_manifest_with_a_bundle_or_an_unknown_role_parses() {
    let m: Manifest = serde_json::from_str(&format!(
        r#"{{"product":"daedalus-agent","version":"0.24.0","tag":"agent-v0.24.0","assets":[
            {{"target":"universal-apple-darwin","role":"bundle","name":"daedalus-agent-universal-apple-darwin.app.zip","sha256":"{a}","size":1234}},
            {{"target":"universal-apple-darwin","role":"installer","name":"daedalus-agent-macos.dmg","sha256":"{b}","size":99}},
            {{"target":"x86_64-pc-windows-msvc","role":"service","name":"daedalus-agent-x86_64-pc-windows-msvc.exe","sha256":"{a}","size":5}}]}}"#,
        a = "ab".repeat(32),
        b = "cd".repeat(32),
    ))
    .unwrap();
    assert_eq!(m.assets.len(), 3);
    assert_eq!(m.assets[0], bundle_entry());
    assert_eq!(m.assets[1].role, "installer");
}

#[cfg(not(target_os = "macos"))]
#[test]
fn a_newer_bundle_only_release_is_a_re_install_never_an_install() {
    let running = semver::Version::parse("0.23.0").unwrap();
    let offer = |m: &Manifest, r: &ApiRelease, refused: Option<&semver::Version>| {
        offer_of(m, r, &running, refused, |_| true, MAC)
    };
    // Bundle only, newer: a re-install of its version, with nothing to
    // download or swap.
    let b = bundled("0.24.0", false);
    assert_eq!(
        offer(&b, &listed(&b), None).unwrap(),
        Offered::Reinstall(semver::Version::parse("0.24.0").unwrap())
    );
    // Bare binaries for this target: the ordinary update, a bundle and a
    // DMG beside them changing nothing.
    let bare = bundled("0.24.0", true);
    let Offered::Assets(v, got) = offer(&bare, &listed(&bare), None).unwrap() else {
        panic!("bare binaries are installed");
    };
    assert_eq!(v.to_string(), "0.24.0");
    assert_eq!(got.len(), ASSETS.len() + OPTIONAL_ASSETS.len());
    assert!(got.iter().all(|a| !a.url.ends_with(".app.zip")));
    // The same, when the manifest is the old form alone.
    let m = manifest("0.24.0", true, b"bin");
    assert!(matches!(
        offer(&m, &listed(&m), None).unwrap(),
        Offered::Assets(..)
    ));
    // Older or the same, rolled back from, another product, another tag:
    // nothing, bundle or not.
    for old in ["0.23.0", "0.22.0"] {
        let o = bundled(old, false);
        assert!(offer(&o, &listed(&o), None).is_err(), "{old}");
    }
    let refused = semver::Version::parse("0.24.0").unwrap();
    assert!(offer(&b, &listed(&b), Some(&refused)).is_err());
    let theirs = Manifest {
        product: "santree".into(),
        ..b.clone()
    };
    assert!(offer(&theirs, &listed(&theirs), None).is_err());
    let r = ApiRelease {
        tag_name: "agent-v0.25.0".into(),
        ..listed(&b)
    };
    assert!(offer(&b, &r, None).is_err());
    // A bundle the release does not carry, or one for another target:
    // skipped as before.
    let mut short = listed(&b);
    short.assets.retain(|a| !a.name.ends_with(".app.zip"));
    assert!(offer(&b, &short, None).is_err());
    let mut elsewhere = b.clone();
    elsewhere.assets[0].target = "x86_64-unknown-freebsd".into();
    assert!(offer(&elsewhere, &listed(&elsewhere), None).is_err());
    // A bare binary for this target that is broken is its refusal, not a
    // re-install.
    let mut broken = bundled("0.24.0", true);
    broken.assets[0].sha256 = "zz".into();
    assert!(offer(&broken, &listed(&broken), None).is_err());
}

#[test]
fn no_target_is_a_re_install_in_this_version() {
    // 0.24 applies the Mac's bundle itself: nothing is left to re-install.
    assert!(BUNDLE_TARGETS.is_empty());
}

#[cfg(not(target_os = "macos"))]
#[test]
fn windows_and_linux_never_see_a_bundle() {
    let running = semver::Version::parse("0.23.0").unwrap();
    let offer = |m: &Manifest| offer_of(m, &listed(m), &running, None, |_| true, &[]);
    // A Mac-only release is skipped, as it always was.
    assert!(offer(&bundled("0.24.0", false)).is_err());
    // A release with this target's binaries is installed exactly as the
    // old form of it is: the Mac's bundle and DMG beside them are ignored.
    let with = bundled("0.24.0", true);
    let without = manifest("0.24.0", true, b"bin");
    let (Offered::Assets(_, a), Offered::Assets(_, b)) =
        (offer(&with).unwrap(), offer(&without).unwrap())
    else {
        panic!("both are installed");
    };
    assert_eq!(a, b);
    assert_eq!(
        assets_of(&with, &listed(&with), &running, None, |_| true).unwrap(),
        assets_of(&without, &listed(&without), &running, None, |_| true).unwrap()
    );
}

#[test]
fn a_download_is_kept_only_at_the_manifests_size_and_hash() {
    use sha2::Digest;
    let dir = std::env::temp_dir().join(format!("daedalus-download-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("daedalus-agent.new");
    let body = b"the new binary".to_vec();
    let sha: [u8; 32] = sha2::Sha256::digest(&body).into();
    store_verified(&body[..], &path, body.len() as u64, &sha).unwrap();
    assert_eq!(std::fs::read(&path).unwrap(), body);
    // Longer than stated: refused before it is all read, and removed.
    assert!(store_verified(&body[..], &path, 4, &sha).is_err());
    assert!(!path.exists());
    // Shorter, or other bytes: refused, removed.
    assert!(store_verified(&body[..], &path, 100, &sha).is_err());
    assert!(store_verified(&b"the old binary"[..], &path, 14, &sha).is_err());
    assert!(!path.exists());
    let _ = std::fs::remove_dir_all(&dir);
}

#[cfg(not(target_os = "macos"))]
#[test]
fn a_bad_copy_is_retired_like_an_old_one() {
    for yes in ["daedalus-agent.exe.bad", "daedalus-agent.exe.bad.2"] {
        assert!(is_retired("daedalus-agent.exe", yes), "{yes}");
    }
    for no in ["daedalus-agent.exe.badx", "daedalus-agent.exe.bad."] {
        assert!(!is_retired("daedalus-agent.exe", no), "{no}");
    }
}

fn on_probation(version: &str, starts: u32) -> crate::state::State {
    crate::state::State {
        probation: Some(crate::state::Probation {
            version: version.into(),
            from: "0.18.0".into(),
            starts,
            installed_at: "t0".into(),
        }),
        ..Default::default()
    }
}

#[test]
fn a_new_version_counts_its_starts_and_is_rolled_back_past_the_limit() {
    // Nothing on probation: an ordinary start.
    let mut s = crate::state::State::default();
    assert_eq!(judge_start(&mut s, "0.19.0", "t"), Start::Normal);
    // Installed: each start counts, up to MAX_STARTS.
    let mut s = crate::state::State::default();
    begin_probation(&mut s, "0.19.0", "t0");
    assert_eq!(s.probation.as_ref().unwrap().from, crate::VERSION);
    for n in 1..=MAX_STARTS {
        assert_eq!(judge_start(&mut s, "0.19.0", "t"), Start::Probation(n));
        assert_eq!(s.probation.as_ref().unwrap().starts, n);
    }
    // One more: rolled back, remembered, the probation gone.
    let mut s = on_probation("0.19.0", MAX_STARTS);
    s.probation.as_mut().unwrap().from = "0.18.0".into();
    let r = crate::state::RolledBack {
        version: "0.19.0".into(),
        to: "0.18.0".into(),
        starts: MAX_STARTS,
        at: "t9".into(),
    };
    assert_eq!(
        judge_start(&mut s, "0.19.0", "t9"),
        Start::RollBack(r.clone())
    );
    assert_eq!(s.probation, None);
    assert_eq!(s.rolled_back, Some(r));
    // Another version runs than the one on probation (put back by
    // hand): nothing is counted, and the probation is over.
    let mut s = on_probation("0.19.0", 1);
    assert_eq!(judge_start(&mut s, "0.18.0", "t"), Start::Normal);
    assert_eq!(s.probation, None);
    // A newer install forgets the version rolled back from.
    let mut s = crate::state::State {
        rolled_back: Some(crate::state::RolledBack {
            version: "0.19.0".into(),
            ..Default::default()
        }),
        ..Default::default()
    };
    begin_probation(&mut s, "0.20.0", "t");
    assert_eq!(s.rolled_back, None);
    assert_eq!(s.probation.unwrap().version, "0.20.0");
}

#[test]
fn only_newer_tags_of_ours_are_candidates_newest_first() {
    let tagged = |tag: &str| ApiRelease {
        tag_name: tag.into(),
        draft: false,
        prerelease: false,
        assets: Vec::new(),
    };
    let running = semver::Version::parse("0.18.0").unwrap();
    let tags = |c: Vec<(semver::Version, ApiRelease)>| -> Vec<String> {
        c.into_iter().map(|(v, _)| v.to_string()).collect()
    };
    let draft = ApiRelease {
        draft: true,
        ..tagged("agent-v0.20.0")
    };
    let pre = ApiRelease {
        prerelease: true,
        ..tagged("agent-v0.21.0")
    };
    let all = || {
        vec![
            tagged("agent-v0.19.0"),
            tagged("agent-v0.18.0"),
            tagged("agent-v0.19.1"),
            tagged("v0.30.0"),
            tagged("agent-vnope"),
        ]
    };
    assert_eq!(
        tags(candidates(
            all().into_iter().chain([draft, pre]).collect(),
            &running,
            None
        )),
        ["0.19.1", "0.19.0"]
    );
    let refused = semver::Version::parse("0.19.1").unwrap();
    assert_eq!(
        tags(candidates(all(), &running, Some(&refused))),
        ["0.19.0"]
    );
}

#[cfg(not(target_os = "macos"))]
#[test]
fn a_roll_back_puts_the_old_binaries_back_and_keeps_the_bad_ones_aside() {
    let dir = std::env::temp_dir().join(format!("daedalus-rollback-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let service = ASSETS[0].2;
    // Nothing to go back to: refused, nothing moved.
    std::fs::write(dir.join(service), "new").unwrap();
    assert!(roll_back_in(&dir).is_err());
    assert_eq!(std::fs::read_to_string(dir.join(service)).unwrap(), "new");
    for (_, _, local) in ASSETS {
        std::fs::write(dir.join(local), "new").unwrap();
        std::fs::write(dir.join(format!("{local}.old")), "old").unwrap();
    }
    // A `.bad` from an earlier rollback is replaced.
    std::fs::write(dir.join(format!("{service}.bad")), "older bad").unwrap();
    roll_back_in(&dir).unwrap();
    for (_, _, local) in ASSETS {
        assert_eq!(std::fs::read_to_string(dir.join(local)).unwrap(), "old");
        assert_eq!(
            std::fs::read_to_string(dir.join(format!("{local}.bad"))).unwrap(),
            "new"
        );
        assert!(!dir.join(format!("{local}.old")).exists());
    }
    retire_in(&dir);
    for (_, _, local) in ASSETS {
        assert!(dir.join(local).exists());
        assert!(!dir.join(format!("{local}.bad")).exists());
    }
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_probation_run_proves_itself_by_its_page_and_a_report_when_someone_is_there() {
    let s = Duration::from_secs;
    let asked = std::cell::Cell::new(false);
    let present = || {
        asked.set(true);
        true
    };
    // Not yet up long enough: wait, and nobody is asked.
    assert_eq!(judge_proof(Some(s(60)), s(60), present, true), Proof::Wait);
    assert!(!asked.get());
    // Up, and the tray reported.
    assert!(matches!(
        judge_proof(Some(s(120)), s(125), || true, true),
        Proof::Proven(r) if r.contains("reported")
    ));
    // Up, nobody logged on: uptime alone.
    assert!(matches!(
        judge_proof(Some(s(120)), s(125), || false, false),
        Proof::Proven(r) if r.contains("nobody")
    ));
    // Up, someone there, no report: wait, then the run failed.
    assert_eq!(
        judge_proof(Some(s(200)), s(200), || true, false),
        Proof::Wait
    );
    assert!(matches!(
        judge_proof(Some(s(300)), REPORT_WINDOW, || true, false),
        Proof::Failed(w) if w.contains("no tray")
    ));
    // A page that never came up fails at the window too.
    assert!(matches!(
        judge_proof(None, REPORT_WINDOW, || false, false),
        Proof::Failed(w) if w.contains("never")
    ));
}

/// A Mac's update is the app bundle: one asset, the `.app.zip`, whatever
/// else the release carries (the disk image, other targets' binaries); a
/// release of the old form — bare binaries for this target — is not one.
#[cfg(target_os = "macos")]
#[test]
fn a_mac_updates_to_the_bundle_and_ignores_the_disk_image() {
    let running = semver::Version::parse("0.23.1").unwrap();
    let offer = |m: &Manifest| offer_of(m, &listed(m), &running, None, |_| true, MAC);
    let b = bundled("0.24.0", false);
    let Offered::Assets(v, got) = offer(&b).unwrap() else {
        panic!("the bundle is installed");
    };
    assert_eq!(v.to_string(), "0.24.0");
    assert_eq!(got.len(), 1);
    assert!(got[0]
        .url
        .ends_with("daedalus-agent-universal-apple-darwin.app.zip"));
    assert_eq!(got[0].size, 1234);
    let old = Manifest {
        assets: [
            ("service", "daedalus-agent-universal-apple-darwin"),
            ("tray", "daedalus-agent-tray-universal-apple-darwin"),
        ]
        .map(|(role, name)| ManifestAsset {
            target: MAC[0].into(),
            role: role.into(),
            name: name.into(),
            sha256: "ab".repeat(32),
            size: 5,
        })
        .into(),
        ..b.clone()
    };
    assert!(offer(&old).is_err());
}
