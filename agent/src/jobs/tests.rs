//! The job builders and parsers, on every OS.

use super::*;

const ID: &str = "abdda3a9-0cb2-43f1-b13e-37f25a755fce";

fn tools() -> Tools {
    Tools {
        sh: "/bin/sh".into(),
        script: "/usr/bin/script".into(),
        sed: "/usr/bin/sed".into(),
        grep: "/usr/bin/grep".into(),
    }
}

#[test]
fn systemd_show_reads_running_exited_and_gone() {
    let running = "LoadState=loaded\nActiveState=active\nSubState=running\nMainPID=4242\n\
                       ExecMainCode=0\nExecMainStatus=0\nExecMainStartTimestampMonotonic=1000000\n\
                       WorkingDirectory=/home/ana/projects/x\n";
    assert_eq!(
        parse_systemd_show(running, Some(91_000_000)),
        JobState::Running {
            pid: Some(4242),
            age_secs: Some(90),
            workdir: Some(PathBuf::from("/home/ana/projects/x"))
        }
    );
    let exited = "LoadState=loaded\nActiveState=failed\nSubState=failed\nMainPID=0\n\
                      ExecMainCode=1\nExecMainStatus=3\n";
    assert_eq!(
        parse_systemd_show(exited, None),
        JobState::Exited("3".into())
    );
    let clean = "LoadState=loaded\nActiveState=active\nSubState=exited\nMainPID=0\n\
                     ExecMainCode=1\nExecMainStatus=0\n";
    assert_eq!(
        parse_systemd_show(clean, None),
        JobState::Exited("0".into())
    );
    let killed =
        "LoadState=loaded\nActiveState=failed\nSubState=failed\nExecMainCode=2\nExecMainStatus=9\n";
    assert_eq!(
        parse_systemd_show(killed, None),
        JobState::Exited("signal".into())
    );
    let starting = "LoadState=loaded\nActiveState=activating\nSubState=start\nMainPID=0\n\
                        ExecMainStartTimestampMonotonic=0\nWorkingDirectory=\n";
    assert_eq!(
        parse_systemd_show(starting, Some(5)),
        JobState::Running {
            pid: None,
            age_secs: None,
            workdir: None
        }
    );
    assert_eq!(
        parse_systemd_show("LoadState=not-found\nActiveState=inactive\n", None),
        JobState::Gone
    );
    assert_eq!(
        parse_systemd_show(
            "LoadState=loaded\nActiveState=inactive\nSubState=dead\n",
            None
        ),
        JobState::Gone
    );
}

#[cfg(unix)]
#[test]
fn systemd_run_gets_the_unit_the_log_and_the_environment() {
    let env = job_env(
        Some(Path::new("/home/ana")),
        Some("/usr/bin:/bin"),
        None,
        &[],
    );
    assert_eq!(
        env,
        vec![
            (
                "CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE".to_string(),
                "1".to_string()
            ),
            ("HOME".into(), "/home/ana".into()),
            ("PATH".into(), "/home/ana/.local/bin:/usr/bin:/bin".into()),
        ]
    );
    let a = systemd_server_args(&ServerJob {
        name: "daedalus-claude-rc",
        cli: Path::new("/home/ana/.local/bin/claude"),
        workdir: Path::new("/home/ana/p"),
        log: Path::new("/home/ana/.local/state/daedalus-agent/claude-rc.log"),
        env: &env,
    });
    assert_eq!(
        a,
        [
            "--user",
            "--unit=daedalus-claude-rc",
            "--description=Claude Code remote control (daedalus-agent)",
            "--property=RemainAfterExit=yes",
            "--property=TimeoutStopSec=15",
            "--property=StandardOutput=append:/home/ana/.local/state/daedalus-agent/claude-rc.log",
            "--property=StandardError=append:/home/ana/.local/state/daedalus-agent/claude-rc.log",
            "--working-directory=/home/ana/p",
            "--setenv=CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE=1",
            "--setenv=HOME=/home/ana",
            "--setenv=PATH=/home/ana/.local/bin:/usr/bin:/bin",
            "--",
            "/home/ana/.local/bin/claude",
            "remote-control",
            "--verbose",
        ]
    );
    let with_dir = job_env(None, None, Some("/srv/claude"), &[]);
    assert_eq!(with_dir.last().unwrap().0, "CLAUDE_CONFIG_DIR");
    // macOS adds Homebrew after the session's PATH, once.
    let mac = job_env(
        None,
        Some("/usr/bin:/opt/homebrew/bin"),
        None,
        &["/opt/homebrew/bin", "/usr/local/bin"],
    );
    assert_eq!(
        mac[1],
        (
            "PATH".into(),
            "/usr/bin:/opt/homebrew/bin:/usr/local/bin".into()
        )
    );
}

#[cfg(unix)]
#[test]
fn a_systemd_resume_is_one_fixed_command_line() {
    let base = job_env(
        Some(Path::new("/home/ana")),
        Some("/usr/bin:/bin"),
        None,
        &[],
    );
    let env = session_env(base, true, Some(Path::new("/bin/sh")));
    assert_eq!(
        env,
        [
            ("CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE", "1"),
            ("HOME", "/home/ana"),
            (
                "PATH",
                "/home/ana/.local/bin:/run/wrappers/bin:/usr/bin:/bin"
            ),
            ("TERM", "xterm-256color"),
            ("SHELL", "/bin/sh"),
        ]
        .map(|(k, v)| (k.to_string(), v.to_string()))
    );
    let name = format!("claude-session-{ID}");
    let job = SessionJob {
        name: &name,
        id: ID,
        cli: Path::new("/home/ana/.local/bin/claude"),
        label: "s2-server",
        cwd: Path::new("/etc/nixos"),
        log: Path::new("/logs/claude-session.log"),
        env: &env[..1],
    };
    let a = systemd_session_args(&job, &tools()).unwrap();
    assert_eq!(
            a,
            [
                "--user".to_string(),
                format!("--unit=claude-session-{ID}"),
                format!("--description=Claude Code session {ID}, resumed by daedalus-agent"),
                "--property=TimeoutStopSec=15".into(),
                "--property=SuccessExitStatus=143".into(),
                "--collect".into(),
                "--property=StandardOutput=append:/logs/claude-session.log".into(),
                "--property=StandardError=append:/logs/claude-session.log".into(),
                "--working-directory=/etc/nixos".into(),
                "--setenv=CLAUDE_CODE_PACKAGE_MANAGER_AUTO_UPDATE=1".into(),
                "--".into(),
                "/bin/sh".into(),
                "-c".into(),
                format!(
                    "'/usr/bin/script' -qfec '\"/home/ana/.local/bin/claude\" --resume {ID} --remote-control s2-server' /dev/null \
                     | '/usr/bin/sed' -u -E 's/\\x1b\\[[0-9;]*[A-Za-z]//g; s/\\x1b\\]8;;[^\\x07]*\\x07//g; /./!d' \
                     | {{ '/usr/bin/grep' --line-buffered -Ev '^·|^[[:space:]]' || true; }}"
                ),
            ]
        );
    assert!(!a.last().unwrap().contains(['$', '%']));
    // Nothing from outside the checks reaches it.
    let bad = |id: &str, cli: &str, label: &str| {
        let j = SessionJob {
            name: "u",
            id,
            cli: Path::new(cli),
            label,
            cwd: Path::new("/p"),
            log: Path::new("/l"),
            env: &[],
        };
        systemd_session_args(&j, &tools()).is_err() && macos_session_line(&j, &tools()).is_err()
    };
    assert!(bad("0a1b2c3d", "/c", "l"));
    assert!(bad(ID, "/home/$USER/claude", "l"));
    assert!(bad(ID, "/home/a\"b/claude", "l"));
    assert!(bad(ID, "/c", "a b"));
    assert!(bad(ID, "/c", "x;rm"));
    assert!(bad(ID, "/c", ""));
    // PATH already carrying the wrappers is left as it is.
    let env = session_env(
        vec![("PATH".into(), "/run/wrappers/bin:/bin".into())],
        true,
        None,
    );
    assert_eq!(env[0], ("PATH".into(), "/run/wrappers/bin:/bin".into()));
}

#[test]
fn a_launchd_job_is_a_plist_and_a_bsd_script_line() {
    let env = vec![("HOME".to_string(), "/Users/ana".to_string())];
    let p = launchd_plist(
        &launchd_label("daedalus-claude-rc"),
        &[
            "/Users/ana/.local/bin/claude".into(),
            "remote-control".into(),
            "--verbose".into(),
        ],
        Path::new("/Users/ana/p & q"),
        Path::new("/Users/ana/Library/Logs/daedalus-agent/claude-rc.log"),
        &env,
    );
    assert!(p.contains(
        "<key>Label</key><string>me.toscanini.daedalus-agent.daedalus-claude-rc</string>"
    ));
    assert!(p.contains("<string>remote-control</string>"));
    assert!(p.contains("<key>WorkingDirectory</key><string>/Users/ana/p &amp; q</string>"));
    assert!(p.contains("<key>HOME</key><string>/Users/ana</string>"));
    assert!(p.contains("<key>KeepAlive</key><false/>"));
    assert!(p.contains("<key>RunAtLoad</key><true/>"));
    assert!(!p.bytes().any(|b| b < 0x20 && b != b'\n'));
    let name = format!("claude-session-{ID}");
    let line = macos_session_line(
        &SessionJob {
            name: &name,
            id: ID,
            cli: Path::new("/Users/ana/.local/bin/claude"),
            label: "Anas-MacBook",
            cwd: Path::new("/Users/ana/p"),
            log: Path::new("/l"),
            env: &[],
        },
        &tools(),
    )
    .unwrap();
    assert_eq!(
            line,
            format!(
                "e=$(printf '\\033'); b=$(printf '\\007'); '/usr/bin/script' -q /dev/null \
                 '/Users/ana/.local/bin/claude' --resume {ID} --remote-control Anas-MacBook \
                 | '/usr/bin/sed' -l -E \"s/${{e}}\\[[0-9;]*[A-Za-z]//g; s/${{e}}]8;;[^${{b}}]*${{b}}//g; /./!d\" \
                 | {{ '/usr/bin/grep' --line-buffered -Ev '^·|^[[:space:]]' || true; }}"
            )
        );
}

#[test]
fn launchctl_print_and_list_read_as_job_states() {
    let running = "gui/501/me.toscanini.daedalus-agent.daedalus-claude-rc = {\n\
                       \tactive count = 1\n\tpath = /x.plist\n\tstate = running\n\n\
                       \tprogram = /bin/sh\n\targuments = {\n\t\tstate = nested\n\t\tpid = 1\n\t}\n\n\
                       \tworking directory = /Users/ana/p\n\tpid = 4242\n\
                       \tlast exit code = (never exited)\n}\n";
    let want = Some(JobState::Running {
        pid: Some(4242),
        age_secs: None,
        workdir: Some("/Users/ana/p".into()),
    });
    assert_eq!(parse_launchctl_print(running), want);
    // Another indentation (spaces, none at all) reads the same: the
    // service's level is found by its braces.
    let spaces = running.replace('\t', "    ");
    assert_eq!(parse_launchctl_print(&spaces), want);
    let flat = running.replace('\t', "");
    assert_eq!(parse_launchctl_print(&flat), want);
    // A pid alone says it runs, whatever `state` says.
    let pid_only = "x = {\n  state = waiting\n  pid = 77\n}\n";
    assert!(matches!(
        parse_launchctl_print(pid_only),
        Some(JobState::Running { pid: Some(77), .. })
    ));
    let exited = "x = {\n\tstate = not running\n\tlast exit code = 78: EX_CONFIG\n}\n";
    assert_eq!(
        parse_launchctl_print(exited),
        Some(JobState::Exited("78".into()))
    );
    let killed = "x = {\n\tstate = not running\n\tlast terminating signal = Terminated: 15\n}\n";
    assert_eq!(
        parse_launchctl_print(killed),
        Some(JobState::Exited("signal".into()))
    );
    // Unreadable is unknown (None), never gone: a nested `state` does
    // not count, and neither does text that is no service at all.
    assert_eq!(parse_launchctl_print(""), None);
    assert_eq!(parse_launchctl_print("some new format\n"), None);
    assert_eq!(
        parse_launchctl_print("x = {\n  arguments = {\n    state = running\n  }\n}\n"),
        None
    );
    assert!(launchctl_says_gone(113, ""));
    assert!(launchctl_says_gone(
        1,
        "Could not find service \"x\" in domain for user gui: 501"
    ));
    assert!(!launchctl_says_gone(5, "Input/output error"));
    let list = "PID\tStatus\tLabel\n4242\t0\tme.toscanini.daedalus-agent.claude-session-a\n\
                    -\t0\tme.toscanini.daedalus-agent.claude-session-b\n\
                    17\t0\tcom.apple.x\n";
    assert_eq!(
        parse_launchctl_list(list, "me.toscanini.daedalus-agent.claude-session-"),
        ["me.toscanini.daedalus-agent.claude-session-a"]
    );
    assert_eq!(parse_etime("05:07"), Some(307));
    assert_eq!(parse_etime(" 1:00:00"), Some(3600));
    assert_eq!(parse_etime("2-00:00:01"), Some(172_801));
    assert_eq!(parse_etime("x"), None);
}

#[test]
fn the_claude_a_job_runs_is_read_off_its_command_line() {
    let h = "/nix/store/406b184jzwfcj0gwscggw3p72l65qdyp-claude-code-2.1.281";
    // systemd's ExecStart, the server's and a resumed session's.
    let server = format!(
            "ExecStart={{ path={h}/bin/claude ; argv[]={h}/bin/claude remote-control --verbose ; ignore_errors=no }}"
        );
    assert_eq!(
        claude_in_command(&server),
        Some(PathBuf::from(format!("{h}/bin/claude")))
    );
    let session = format!(
            "ExecStart={{ path=/bin/sh ; argv[]=/bin/sh -c '/usr/bin/script' -qfec '\"{h}/bin/claude\" --resume x' /dev/null | '/usr/bin/sed' ; }}"
        );
    assert_eq!(
        claude_in_command(&session),
        Some(PathBuf::from(format!("{h}/bin/claude")))
    );
    // A launchd plist's arguments.
    let plist = "<string>/bin/sh</string>\n<string>'/usr/bin/script' -q /dev/null '/Users/a/.local/bin/claude' --resume x</string>";
    assert_eq!(
        claude_in_command(plist),
        Some(PathBuf::from("/Users/a/.local/bin/claude"))
    );
    assert_eq!(claude_in_command("/usr/bin/claudette run"), None);
    // The holder's copies: this version's is kept, the others swept.
    let names: Vec<String> = [
        "daedalus-agent-0.17.0.exe",
        "daedalus-agent-0.16.0.exe",
        "daedalus-agent-0.17.1.exe.new",
        "notes.txt",
    ]
    .map(String::from)
    .to_vec();
    assert_eq!(holder_file("0.17.0"), "daedalus-agent-0.17.0.exe");
    assert_eq!(
        stale_holders(&names, "0.17.0"),
        ["daedalus-agent-0.16.0.exe", "daedalus-agent-0.17.1.exe.new"]
    );
}

#[test]
fn windows_words_are_quoted_and_shims_go_through_cmd() {
    assert_eq!(windows_quote("plain"), "plain");
    assert_eq!(
        windows_quote("C:\\Program Files\\x"),
        "\"C:\\Program Files\\x\""
    );
    assert_eq!(windows_quote("a\"b"), "\"a\\\"b\"");
    assert_eq!(windows_quote("end\\ "), "\"end\\ \"");
    assert_eq!(windows_quote("trail\\"), "trail\\");
    assert_eq!(windows_quote("sp trail\\"), "\"sp trail\\\\\"");
    assert_eq!(windows_quote(""), "\"\"");
    let sys = "C:\\Windows\\system32";
    assert_eq!(
        windows_session_command(sys, "C:\\Users\\ana\\.local\\bin\\claude.exe", ID, "pc").unwrap(),
        format!("\"C:\\Users\\ana\\.local\\bin\\claude.exe\" --resume {ID} --remote-control pc")
    );
    assert_eq!(
        windows_session_command(sys, "C:\\Users\\a b\\npm\\claude.cmd", ID, "pc").unwrap(),
        format!(
            "\"C:\\Windows\\system32\\cmd.exe\" /d /s /c \"\"C:\\Users\\a b\\npm\\claude.cmd\" --resume {ID} --remote-control pc\""
        )
    );
    // cmd's separators in the path stay inside its quotes.
    assert_eq!(
        windows_session_command(sys, "C:\\Tom&Jerry\\claude.cmd", ID, "pc").unwrap(),
        format!(
            "\"C:\\Windows\\system32\\cmd.exe\" /d /s /c \"\"C:\\Tom&Jerry\\claude.cmd\" --resume {ID} --remote-control pc\""
        )
    );
    // A bare name would be searched for, the working directory first.
    assert!(windows_session_command(sys, "claude.cmd", ID, "pc").is_err());
    assert!(windows_session_command("system32", "C:\\c.cmd", ID, "pc").is_err());
    assert!(windows_session_command(sys, "C:\\c.exe", "0a1b2c3d", "pc").is_err());
    assert!(windows_session_command(sys, "C:\\c.exe", ID, "a&b").is_err());
    assert!(windows_absolute("\\\\server\\share\\c.exe") && !windows_absolute("C:c.exe"));
    let r = JobRecord {
        pid: 42,
        created: 133_000_000_000_000_000,
        workdir: "C:\\p".into(),
        started_at: "2026-09-28T00:00:00Z".into(),
    };
    let back: JobRecord = serde_json::from_str(&serde_json::to_string(&r).unwrap()).unwrap();
    assert_eq!(back, r);
}

#[test]
fn the_line_filter_strips_what_a_terminal_writes() {
    let mut f = LineFilter::default();
    let mut out = f.feed(b"\x1b[?25l\x1b[2J\x1b[HHello \x1b[1mworld\x1b[0m\r\n");
    out.extend(f.feed(b"\x1b]8;;https://x\x07link\x1b]8;;\x07 text\r\n"));
    out.extend(f.feed(b"\xc2\xb7 status box\r\n   indented\r\n\r\n"));
    out.extend(f.feed(b"\x1b]0;title\x1b\\tail with no end"));
    assert_eq!(out, ["Hello world", "link text"]);
    assert_eq!(f.finish(), ["tail with no end"]);
    // A character split across two reads is kept whole.
    let mut g = LineFilter::default();
    assert!(g.feed(&[b'a', 0xC3]).is_empty());
    assert_eq!(g.feed(&[0xA9, b'\n']), ["aé"]);
}

#[test]
fn the_tail_reads_whole_lines_from_the_last_marker() {
    let dir = std::env::temp_dir().join(format!("daedalus-job-tail-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let log = dir.join("claude-rc.log");
    std::fs::write(
            &log,
            format!(
                "── t0 x {MARKER} in /a ──\nRemote Control v1.0.0\nold line\n\
                 ── t1 daedalus-agent session {MARKER} in /b (job u) ──\nRemote Control v2.1.0\r\nEnvironment ID: env_1\npart"
            ),
        )
        .unwrap();
    let mut t = LogTail::at_last_marker(log.clone());
    assert_eq!(
        t.read_new(),
        ["Remote Control v2.1.0", "Environment ID: env_1"]
    );
    assert!(t.read_new().is_empty());
    use std::io::Write;
    let mut f = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
    write!(f, "ial\nnext\n").unwrap();
    assert_eq!(t.read_new(), ["partial", "next"]);
    // Truncated under it: from the start again.
    std::fs::write(&log, "fresh\n").unwrap();
    assert_eq!(t.read_new(), ["fresh"]);
    // A character split across two writes is read whole.
    let mut f = std::fs::OpenOptions::new().append(true).open(&log).unwrap();
    f.write_all(&[b'a', 0xC3]).unwrap();
    assert!(t.read_new().is_empty());
    f.write_all(&[0xA9, b'\n']).unwrap();
    assert_eq!(t.read_new(), ["aé"]);
    // Bytes that are not UTF-8 before the marker do not move the offset.
    let mut raw = vec![0xFF, 0xFE, b'\n'];
    raw.extend_from_slice(format!("── t2 {MARKER} ──\nafter\n").as_bytes());
    std::fs::write(&log, &raw).unwrap();
    assert_eq!(LogTail::at_last_marker(log.clone()).read_new(), ["after"]);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_session_shell_is_the_logins_never_sh() {
    // `systemctl --user show-environment`, as the controller's user manager
    // printed it on 2026-09-29.
    let manager = "HOME=/home/ana\nPATH=/run/wrappers/bin:/etc/profiles/per-user/ana/bin:/run/current-system/sw/bin\n\
                   SHELL=/run/current-system/sw/bin/bash\nXDG_RUNTIME_DIR=/run/user/1000\n";
    assert_eq!(
        manager_env_value(manager, "SHELL").as_deref(),
        Some("/run/current-system/sw/bin/bash")
    );
    assert_eq!(
        manager_env_value(manager, "PATH").as_deref(),
        Some("/run/wrappers/bin:/etc/profiles/per-user/ana/bin:/run/current-system/sw/bin")
    );
    assert_eq!(
        manager_env_value("SHELLX=/bin/zsh\nSHELL=\n", "SHELL"),
        None
    );
    assert_eq!(manager_env_value("", "PATH"), None);

    let passwd = "root:x:0:0:System administrator:/root:/run/current-system/sw/bin/bash\n\
                  ana:x:1000:100::/home/ana:/run/current-system/sw/bin/zsh\n";
    assert_eq!(
        login_shell(passwd, Path::new("/home/ana")),
        Some(PathBuf::from("/run/current-system/sw/bin/zsh"))
    );
    assert_eq!(login_shell(passwd, Path::new("/home/bo")), None);

    // What broke every resumed session after the 26.05 reboot: SHELL=/bin/sh.
    assert!(!runs_commands(Path::new("/bin/sh")));
    assert!(!runs_commands(Path::new("/usr/bin/fish")));
    assert!(runs_commands(Path::new("/run/current-system/sw/bin/bash")));
    assert!(runs_commands(Path::new("/bin/zsh")));
}

#[cfg(unix)]
#[test]
fn a_session_path_keeps_the_agents_tools_first_and_the_logins_profile_after() {
    let env = session_env(
        job_env(
            Some(Path::new("/home/ana")),
            Some("/nix/store/x-claude-code/bin:/nix/store/y-util-linux/bin"),
            None,
            &[
                "/run/wrappers/bin",
                "/etc/profiles/per-user/ana/bin",
                "/run/current-system/sw/bin",
            ],
        ),
        true,
        Some(Path::new("/run/current-system/sw/bin/bash")),
    );
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    assert_eq!(
        get("PATH"),
        Some(
            "/home/ana/.local/bin:/nix/store/x-claude-code/bin:/nix/store/y-util-linux/bin:\
             /run/wrappers/bin:/etc/profiles/per-user/ana/bin:/run/current-system/sw/bin"
        )
    );
    assert_eq!(get("SHELL"), Some("/run/current-system/sw/bin/bash"));
}
