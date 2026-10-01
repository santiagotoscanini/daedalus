use super::transcript::LINE_MAX;
use super::*;

#[test]
fn selectors_and_slugs() {
    assert!(is_uuid("abdda3a9-0cb2-43f1-b13e-37f25a755fce"));
    for bad in [
        "ABDDA3A9-0cb2-43f1-b13e-37f25a755fce",
        "abdda3a9-0cb2-43f1-b13e-37f25a755fc",
        "abdda3a90cb2-43f1-b13e-37f25a755fce0",
        "../../../../etc/passwd-aaaa-bbbbbbbb",
        "abdda3a9-0cb2-43f1-b13e-37f25a755fcg",
    ] {
        assert!(!is_uuid(bad), "{bad}");
    }
    assert!(is_short_id("0a1b2c3d"));
    assert!(!is_short_id("0A1B2C3D") && !is_short_id("0a1b2c3") && !is_short_id("0a1b2c3d4"));
    assert_eq!(slug("/etc/nixos"), "-etc-nixos");
    assert_eq!(slug("/home/a/.x_y/p q"), "-home-a--x-y-p-q");
    assert_eq!(unslug("-etc-nixos"), "/etc/nixos");
    assert_eq!(unslug("C--Users-a"), "C--Users-a");
}

#[test]
fn a_scan_counts_each_kind_of_record() {
    let lines = [
        r#"{"type":"queue-operation","content":"secret prompt","timestamp":"2026-09-27T10:00:00.100Z"}"#,
        r#"{"type":"user","message":{"content":"hi"},"isSidechain":false,"gitBranch":"","version":"2.1.281","timestamp":"2026-09-27T10:00:01Z"}"#,
        r#"{"type":"user","message":{"content":[{"type":"tool_result","content":"x"}]},"timestamp":"2026-09-27T10:00:02Z"}"#,
        r#"{"type":"assistant","message":{"content":[{"type":"thinking","thinking":""},{"type":"thinking","thinking":""}]},"gitBranch":"main"}"#,
        r#"{"type":"user","message":{"content":[{"type":"image","source":{}}]},"attachment":{"type":"file"},"timestamp":"2026-09-27T10:05:00Z"}"#,
        r#"{"type":"last-prompt","lastPrompt":"first"}"#,
        r#"{"type":"last-prompt","lastPrompt":"deploy with   ghp_abcdefghijklmnopqrstuvwx\nnow"}"#,
        r#"{"type":"cost-state","totalCostUSD":1.25,"totalLinesAdded":10,"totalLinesRemoved":2,"totalDuration":5000}"#,
        "not json at all",
    ];
    let m = scan(lines.join("\n").as_bytes());
    assert_eq!(
        m,
        Meta {
            exchanges: 2,
            replies: 1,
            thinking: 2,
            images: 1,
            attached: 1,
            subagents: Some(0),
            span_ms: Some(300_000),
            branch: Some("main".into()),
            cli_version: Some("2.1.281".into()),
            last_prompt: Some("deploy with [redacted] now".into()),
            cost: Some(Cost {
                usd: Some(serde_json::Number::from_f64(1.25).unwrap()),
                lines_added: Some(10.into()),
                lines_removed: Some(2.into()),
                duration_ms: Some(5000.into()),
            }),
        }
    );
    // No sidechain key anywhere: unknown, not zero.
    let bare = scan(&b"{\"type\":\"assistant\"}\n"[..]);
    assert_eq!(bare.subagents, None);
    assert_eq!(bare.span_ms, None);
    assert!(!serde_json::to_string(&m).unwrap().contains("secret"));
}

/// The scan reads records, not text: a key inside a tool's input never
/// stands for the record's own, spacing and escapes do not matter, and
/// a line past `LINE_MAX` is skipped without stopping the scan.
#[test]
fn a_scan_reads_each_record_by_its_own_keys() {
    let lines = [
        // A tool input that names a version and a branch first.
        r#"{"type": "assistant", "message": {"content": [{"type": "tool_use", "input": {"version": "9.9.9", "gitBranch": "evil", "timestamp": "2020-01-01T00:00:00Z"}}]}}"#,
        r#"{"type": "user", "message": {"content": "say \"type\":\"assistant\" here"}, "version": "2.1.283", "gitBranch": "main", "timestamp": "2026-09-27T10:00:00Z"}"#,
        r#"{"type":"user","message":{"content":[{"type":"tool_result","content":[{"type":"image","source":{}}]}]},"timestamp":"2026-09-27T10:01:00Z"}"#,
    ];
    let mut text = lines.join("\n");
    text.push('\n');
    // An oversized record in the middle.
    text.push_str(&format!(
        "{{\"type\":\"user\",\"x\":\"{}\"}}\n",
        "a".repeat(LINE_MAX)
    ));
    text.push_str(r#"{"type":"assistant","timestamp":"2026-09-27T10:02:00Z"}"#);
    let m = scan(text.as_bytes());
    assert_eq!(m.cli_version.as_deref(), Some("2.1.283"));
    assert_eq!(m.branch.as_deref(), Some("main"));
    assert_eq!((m.exchanges, m.replies, m.images), (1, 2, 1));
    assert_eq!(m.span_ms, Some(120_000));
}

#[test]
fn the_head_ranks_titles_and_keeps_first_values() {
    let mut h = Head::default();
    h.note_text(
        br#"{"type":"ai-title","aiTitle":"model's"}
{"type":"user","cwd":"/etc/nixos","timestamp":"2026-09-27T10:00:00Z"}
{"type":"user","cwd":"/other","timestamp":"2026-09-28T10:00:00Z"}
{"type":"custom-title","customTitle":"mine"}
{"type":"user","cwd":"/cut-mid-rec"#,
    );
    assert_eq!(h.cwd.as_deref(), Some("/etc/nixos"));
    assert_eq!(h.started_at.as_deref(), Some("2026-09-27T10:00:00Z"));
    assert_eq!(h.title(), (Some("mine".into()), Some("custom-title")));
    let mut side = Head::default();
    side.note_text(br#"{"type":"ai-title","aiTitle":"model's"}"#);
    side.note_text(br#"{"customTitle":"from the sidecar"}"#);
    assert_eq!(
        side.title(),
        (Some("from the sidecar".into()), Some("sidecar"))
    );
}

#[test]
fn agents_are_copied_field_by_field() {
    let a = parse_agents(
        r#"[{"id":"0a1b2c3d","sessionId":"s","kind":"background","state":"blocked","name":"n","cwd":"/x","startedAt":5,"detail":"content","needs":"a question"},
           {"pid":42,"kind":"interactive","status":"busy","sessionId":"t"}]"#,
    )
    .unwrap();
    assert_eq!(a.len(), 2);
    assert_eq!(a[0].id.as_deref(), Some("0a1b2c3d"));
    assert_eq!(a[0].pid, None);
    assert_eq!(a[1].pid, Some(42));
    let json = serde_json::to_string(&a).unwrap();
    assert!(!json.contains("content") && !json.contains("question"));
    assert_eq!(parse_agents("error: unknown command"), None);
    assert_eq!(parse_agents("{}"), None);
}

#[test]
fn the_tree_lists_regular_uuid_files_in_real_directories() {
    let root = std::env::temp_dir().join(format!("daedalus-roster-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let proj = root.join("-etc-nixos");
    std::fs::create_dir_all(&proj).unwrap();
    let a = "aaaaaaaa-0000-4000-8000-000000000001";
    let b = "aaaaaaaa-0000-4000-8000-000000000002";
    std::fs::write(
        proj.join(format!("{a}.jsonl")),
        "{\"type\":\"user\",\"cwd\":\"/etc/nixos\"}\n",
    )
    .unwrap();
    std::fs::write(proj.join(format!("{b}.jsonl")), "").unwrap();
    std::fs::write(proj.join("not-a-uuid.jsonl"), "x\n").unwrap();
    #[cfg(unix)]
    {
        let c = "aaaaaaaa-0000-4000-8000-000000000003";
        std::os::unix::fs::symlink(
            proj.join(format!("{a}.jsonl")),
            proj.join(format!("{c}.jsonl")),
        )
        .unwrap();
        std::os::unix::fs::symlink(&proj, root.join("-linked")).unwrap();
    }
    let mut s = Scanner::default();
    let mut errors = Vec::new();
    let f = s.transcripts(&root, &mut errors);
    assert_eq!((f.total, f.empty), (1, 1));
    assert_eq!(f.transcripts.len(), 1);
    let t = &f.transcripts[0];
    assert_eq!(
        (t.id.as_str(), t.project.as_str(), t.cwd.as_str()),
        (a, "-etc-nixos", "/etc/nixos")
    );
    assert!(t.cwd_exact);
    assert_eq!(t.meta.as_ref().unwrap().exchanges, 1);
    assert_eq!(find_transcript(&root, a).as_deref(), Some("-etc-nixos"));
    assert_eq!(find_transcript(&root, b).as_deref(), Some("-etc-nixos"));
    #[cfg(unix)]
    assert_eq!(
        find_transcript(&root, "aaaaaaaa-0000-4000-8000-000000000003"),
        None
    );
    let _ = std::fs::remove_dir_all(&root);
}

#[test]
fn a_roster_fits_its_bound_by_dropping_the_oldest() {
    let mut r = Roster {
        transcripts: (0..100)
            .map(|i| Transcript {
                id: format!("{i:036}"),
                title: Some("t".repeat(150)),
                ..Default::default()
            })
            .collect(),
        ..Default::default()
    };
    let full = serde_json::to_vec(&r).unwrap().len();
    r.fit(full);
    assert!(!r.truncated && r.transcripts.len() == 100);
    r.fit(full / 2);
    assert!(r.truncated);
    assert!(serde_json::to_vec(&r).unwrap().len() <= full / 2);
    assert!(r.transcripts.len() < 100 && r.transcripts[0].id == format!("{:036}", 0));
}
