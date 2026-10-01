//! `fs.*` and its confinement, and `workspaces.list` / `workspaces.icon`.

mod common;

use std::path::Path;

use santree_remote_client::proto::{ErrorCode, FsKind, FsReadParams, FsStat};
use serde_json::json;

use common::*;

// ── fs ────────────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn fs_reads_writes_and_confines() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let client = host.client().await;
    let root = host.root();
    let outside = dir.path().join("outside");
    std::fs::create_dir_all(&outside).unwrap();
    let s = |p: &Path| p.to_string_lossy().into_owned();

    // Atomic write, parents created, mode applied; an overwrite keeps it.
    let file = root.join("deep/dir/hello.txt");
    client
        .fs_write(&s(&file), b"hello world".to_vec(), Some(0o640))
        .await
        .unwrap();
    use std::os::unix::fs::PermissionsExt;
    let mode = |p: &Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o7777;
    assert_eq!(mode(&file), 0o640);
    client
        .fs_write(&s(&file), b"hello world".to_vec(), None)
        .await
        .unwrap();
    assert_eq!(mode(&file), 0o640);
    let leftovers: Vec<_> = std::fs::read_dir(file.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(leftovers.len(), 1, "no temp files left: {leftovers:?}");

    // A write's parent must be under the projects root, through no symlink.
    let escape_dir = root.join("escape-dir");
    std::os::unix::fs::symlink(&outside, &escape_dir).unwrap();
    for path in [
        outside.join("x"),
        escape_dir.join("x"),
        root.join("../outside/y"),
    ] {
        let refused = client
            .fs_write(&s(&path), b"no".to_vec(), None)
            .await
            .unwrap_err();
        assert_eq!(refused.code(), Some(&ErrorCode::Outside), "{path:?}");
    }
    assert_eq!(std::fs::read_dir(&outside).unwrap().count(), 0);

    let read = |offset: Option<i64>, len: Option<u64>, within: Option<String>| FsReadParams {
        path: s(&file),
        offset,
        len,
        within,
    };
    let whole = client
        .fs_read(&read(None, None, Some(s(&root))))
        .await
        .unwrap();
    assert_eq!(
        (whole.data.as_slice(), whole.size, whole.eof),
        (&b"hello world"[..], 11, true)
    );
    let head = client.fs_read(&read(Some(0), Some(5), None)).await.unwrap();
    assert_eq!((head.data.as_slice(), head.eof), (&b"hello"[..], false));
    let tail = client.fs_read(&read(Some(-5), None, None)).await.unwrap();
    assert_eq!((tail.data.as_slice(), tail.eof), (&b"world"[..], true));

    // Reads are not confined to the root; `within` still confines one.
    std::fs::write(outside.join("secret"), b"nope").unwrap();
    let plain = client
        .fs_read(&FsReadParams {
            path: s(&outside.join("secret")),
            ..Default::default()
        })
        .await
        .unwrap();
    assert_eq!(plain.data, b"nope");
    let link = root.join("escape");
    std::os::unix::fs::symlink(outside.join("secret"), &link).unwrap();
    for path in [s(&link), format!("{}/../outside/secret", s(&root))] {
        let refused = client
            .fs_read(&FsReadParams {
                path,
                within: Some(s(&root)),
                ..Default::default()
            })
            .await
            .unwrap_err();
        assert_eq!(refused.code(), Some(&ErrorCode::Outside));
    }
    let relative = client
        .fs_read(&FsReadParams {
            path: "relative".into(),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(relative.code(), Some(&ErrorCode::BadRequest));
    let a_dir = client
        .fs_read(&FsReadParams {
            path: s(&root),
            ..Default::default()
        })
        .await
        .unwrap_err();
    assert_eq!(a_dir.code(), Some(&ErrorCode::Io));

    // stat is an lstat; a missing path is an answer, ENOTDIR an io error.
    let st = client.fs_stat(&s(&link)).await.unwrap();
    assert_eq!((st.exists, st.kind), (true, Some(FsKind::Symlink)));
    let st = client.fs_stat(&s(&file)).await.unwrap();
    assert_eq!((st.kind, st.size), (Some(FsKind::File), 11));
    assert!(st.mtime_ms > 0);
    assert_eq!(
        client.fs_stat(&s(&root)).await.unwrap().kind,
        Some(FsKind::Dir)
    );
    assert_eq!(
        client.fs_stat(&s(&root.join("nope"))).await.unwrap(),
        FsStat::default()
    );
    let notdir = client
        .fs_stat(&format!("{}/below", s(&file)))
        .await
        .unwrap_err();
    assert_eq!(notdir.code(), Some(&ErrorCode::Io));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_missing_path_stats_as_the_exact_default_object() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    let missing = dir.path().join("missing");
    let st = raw
        .ok("fs.stat", json!({"path": missing.to_str().unwrap()}))
        .await;
    assert_eq!(
        st,
        json!({"exists": false, "kind": null, "size": 0, "mtimeMs": 0})
    );
}

// ── workspaces ────────────────────────────────────────────────────────────

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspaces_list_serves_the_snapshot() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;
    let root = host.root_str();

    // No snapshot yet: an empty list, generatedAt null.
    assert_eq!(
        raw.ok("workspaces.list", json!({})).await,
        json!({"root": root, "generatedAt": null, "workspaces": []})
    );

    // As the workspace sync publishes it (host/workspace-lib.sh).
    let sync = json!({"result": "ok", "detail": "", "at": "2026-09-29T10:00:00+00:00"});
    let snapshot = json!({
        "daedalusExport": 1, "domain": "workspaces", "schemaVersion": 1, "source": "host",
        "revision": null, "generatedAt": "2026-09-29T10:00:01+00:00",
        "data": {"root": root, "workspaces": [
            {"name": "web", "remote": "o/web", "branch": "main", "head": "abc123def456",
             "headAt": "2026-09-28T09:00:00+00:00", "dirty": true, "ahead": 1, "behind": 0,
             "sync": sync},
            {"name": "fresh", "remote": null, "branch": null, "head": null, "headAt": null,
             "dirty": false, "ahead": null, "behind": null, "sync": null},
            {"name": "..", "remote": null, "branch": null, "head": null, "headAt": null,
             "dirty": false, "ahead": null, "behind": null, "sync": null},
        ]},
    });
    std::fs::write(dir.path().join("workspaces.json"), snapshot.to_string()).unwrap();
    assert_eq!(
        raw.ok("workspaces.list", json!({})).await,
        json!({"root": root, "generatedAt": "2026-09-29T10:00:01+00:00", "workspaces": [
            {"name": "web", "path": format!("{root}/web"), "remote": "o/web", "branch": "main",
             "head": "abc123def456", "headAt": "2026-09-28T09:00:00+00:00", "dirty": true,
             "ahead": 1, "behind": 0, "sync": sync},
            {"name": "fresh", "path": format!("{root}/fresh"), "remote": null, "branch": null,
             "head": null, "headAt": null, "dirty": false, "ahead": null, "behind": null,
             "sync": null},
        ]})
    );

    // A snapshot of another root describes other checkouts: none are served.
    let mut other = snapshot.clone();
    other["data"]["root"] = json!("/elsewhere");
    std::fs::write(dir.path().join("workspaces.json"), other.to_string()).unwrap();
    assert_eq!(
        raw.ok("workspaces.list", json!({})).await["workspaces"],
        json!([])
    );
    std::fs::write(dir.path().join("workspaces.json"), "{").unwrap();
    assert_eq!(
        raw.call("workspaces.list", json!({})).await["err"]["code"],
        "io"
    );
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn workspaces_icon_serves_the_exported_icon() {
    let dir = tempdir();
    let host = Host::start(dir.path());
    let mut raw = host.greeted().await;

    // No icon directory yet (the app has not exported): not_found.
    assert_eq!(
        raw.call("workspaces.icon", json!({"name": "web"})).await["err"]["code"],
        "not_found"
    );

    // As the app writes it (app/src/host/workspace-icons.ts).
    let icons = dir.path().join("icons");
    std::fs::create_dir_all(&icons).unwrap();
    let png = [0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3];
    std::fs::write(icons.join("web.icon"), png).unwrap();
    use base64::Engine;
    assert_eq!(
        raw.ok("workspaces.icon", json!({"name": "web"})).await,
        json!({"contentType": "image/png",
               "data": base64::engine::general_purpose::STANDARD.encode(png)})
    );

    std::fs::write(icons.join("page.icon"), "<html>not an icon</html>").unwrap();
    assert_eq!(
        raw.call("workspaces.icon", json!({"name": "page"})).await["err"]["code"],
        "not_found"
    );
    assert_eq!(
        raw.call("workspaces.icon", json!({"name": "../web"})).await["err"]["code"],
        "bad_request"
    );
    assert_eq!(
        raw.call("workspaces.icon", json!({})).await["err"]["code"],
        "bad_request"
    );
}
