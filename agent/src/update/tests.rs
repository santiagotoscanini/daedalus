//! The feed, the swap and probation, on files and pure state.

use std::path::Path;

use super::*;

#[test]
fn public_key_parses() {
    verifying_key().expect("compiled-in key is a valid ed25519 public key");
}

#[test]
fn rejects_a_wrong_signature() {
    let err = verify(b"asset", &[0u8; 64]).unwrap_err();
    assert!(err.to_string().contains("does not match"));
}

#[test]
fn rejects_a_short_signature() {
    assert!(verify(b"asset", &[0u8; 10]).is_err());
}

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

#[test]
fn suffixed_names() {
    let p = suffixed(Path::new("C:/x/daedalus-agent.exe"), "old");
    assert!(p.ends_with("daedalus-agent.exe.old"));
}

#[test]
fn every_asset_has_a_local_name() {
    for (remote, local) in ASSETS.iter().chain(OPTIONAL_ASSETS) {
        assert!(!remote.is_empty() && !local.is_empty());
        assert!(!local.contains('/') && !local.contains('\\'));
    }
}

/// A release as the API lists it, carrying `names` (each signed when
/// `signed` says so).
fn release(names: &[&str], signed: bool) -> ApiRelease {
    let mut assets = Vec::new();
    for n in names {
        assets.push(ApiAsset {
            name: n.to_string(),
            browser_download_url: format!("https://x/{n}"),
        });
        if signed {
            assets.push(ApiAsset {
                name: format!("{n}.sig"),
                browser_download_url: format!("https://x/{n}.sig"),
            });
        }
    }
    ApiRelease {
        tag_name: "agent-v9.9.9".into(),
        draft: false,
        prerelease: false,
        assets,
    }
}

#[test]
fn required_assets_decide_and_optional_ones_follow_what_is_installed() {
    let required: Vec<&str> = ASSETS.iter().map(|(r, _)| *r).collect();
    let optional: Vec<&str> = OPTIONAL_ASSETS.iter().map(|(r, _)| *r).collect();
    let all: Vec<&str> = required.iter().chain(&optional).copied().collect();
    // Everything there and signed, the optional ones installed: all of them.
    let got = assets_of(&release(&all, true), |_| true).unwrap();
    assert_eq!(got.len(), ASSETS.len() + OPTIONAL_ASSETS.len());
    // Not installed here: only the required ones.
    let got = assets_of(&release(&all, true), |_| false).unwrap();
    assert_eq!(got.len(), ASSETS.len());
    // A release without the optional ones still installs.
    let got = assets_of(&release(&required, true), |_| true).unwrap();
    assert_eq!(got.len(), ASSETS.len());
    // Unsigned: skipped.
    assert!(assets_of(&release(&all, false), |_| true).is_none());
    // A required one missing: skipped.
    assert!(assets_of(&release(&optional, true), |_| true).is_none());
}

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
fn a_version_rolled_back_from_is_never_picked_again_but_a_newer_one_is() {
    let names: Vec<&str> = ASSETS.iter().map(|(r, _)| *r).collect();
    let tagged = |tag: &str| ApiRelease {
        tag_name: tag.into(),
        ..release(&names, true)
    };
    let running = semver::Version::parse("0.18.0").unwrap();
    let got = pick(vec![tagged("agent-v0.19.0")], &running, None, |_| false).unwrap();
    assert_eq!(got.version.to_string(), "0.19.0");
    assert!(pick(
        vec![tagged("agent-v0.19.0")],
        &running,
        Some("0.19.0"),
        |_| false
    )
    .is_none());
    let got = pick(
        vec![tagged("agent-v0.19.0"), tagged("agent-v0.19.1")],
        &running,
        Some("0.19.0"),
        |_| false,
    )
    .unwrap();
    assert_eq!(got.version.to_string(), "0.19.1");
    // Not newer than the running one, a draft or not ours: never.
    let draft = ApiRelease {
        draft: true,
        ..tagged("agent-v0.20.0")
    };
    assert!(pick(
        vec![tagged("agent-v0.18.0"), draft, tagged("v0.30.0")],
        &running,
        None,
        |_| false
    )
    .is_none());
}

#[test]
fn a_roll_back_puts_the_old_binaries_back_and_keeps_the_bad_ones_aside() {
    let dir = std::env::temp_dir().join(format!("daedalus-rollback-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let service = ASSETS[0].1;
    // Nothing to go back to: refused, nothing moved.
    std::fs::write(dir.join(service), "new").unwrap();
    assert!(roll_back_in(&dir).is_err());
    assert_eq!(std::fs::read_to_string(dir.join(service)).unwrap(), "new");
    for (_, local) in ASSETS {
        std::fs::write(dir.join(local), "new").unwrap();
        std::fs::write(dir.join(format!("{local}.old")), "old").unwrap();
    }
    // A `.bad` from an earlier rollback is replaced.
    std::fs::write(dir.join(format!("{service}.bad")), "older bad").unwrap();
    roll_back_in(&dir).unwrap();
    for (_, local) in ASSETS {
        assert_eq!(std::fs::read_to_string(dir.join(local)).unwrap(), "old");
        assert_eq!(
            std::fs::read_to_string(dir.join(format!("{local}.bad"))).unwrap(),
            "new"
        );
        assert!(!dir.join(format!("{local}.old")).exists());
    }
    retire_in(&dir);
    for (_, local) in ASSETS {
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
