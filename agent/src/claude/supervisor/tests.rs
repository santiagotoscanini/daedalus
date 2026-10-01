use super::*;

#[test]
fn not_wanted_is_off_and_only_a_wanted_server_without_claude_is_not_installed() {
    let f = |wanted, installed, foreign| {
        StateFacts {
            wanted,
            installed,
            foreign,
            off_reason: "the policy",
        }
        .settled()
    };
    assert_eq!(
        f(false, false, None),
        Some(("off".to_string(), Some("the policy".to_string())))
    );
    assert_eq!(f(false, true, None).unwrap().0, "off");
    assert_eq!(
        f(false, true, Some("a job runs")).unwrap().1.unwrap(),
        "the policy — but a job runs"
    );
    assert_eq!(f(true, false, None).unwrap().0, "not-installed");
    assert_eq!(f(true, true, None), None);
}

#[test]
fn a_supervisor_that_is_not_wanted_reports_off() {
    // Whatever this machine has installed, not wanted is off.
    let dir = std::env::temp_dir().join(format!("daedalus-sup-{}", std::process::id()));
    let sup = Supervisor::new(
        Some(dir.display().to_string()),
        dir.join("claude-rc.log"),
        false,
        format!("daedalus-agent-test-{}", std::process::id()),
        dir.join("gcroots"),
    );
    let r = sup.report();
    assert_eq!(r.state, "off");
    assert!(sup.server_pid().is_none() && !sup.registered() && sup.starts() == 0);
    assert_eq!(
        r.summary().sessions,
        r.sessions.iter().filter(|s| s.alive).count()
    );
    let _ = std::fs::remove_dir_all(&dir);
}

// ── the state machine, against fake jobs and a fake clock ────────────

use crate::jobs::{Listed, SessionJob};
use std::sync::{Arc, Mutex};

/// The jobs as a test sets them: the one state every `show` answers,
/// and what was started and cleared.
struct Fake {
    state: Result<JobState, String>,
    starts: u32,
    clears: u32,
}

#[derive(Clone)]
struct Jobs(Arc<Mutex<Fake>>);

impl Jobs {
    fn set(&self, s: Result<JobState, String>) {
        self.0.lock().unwrap().state = s;
    }
    fn starts(&self) -> u32 {
        self.0.lock().unwrap().starts
    }
}

fn running(pid: u32) -> Result<JobState, String> {
    Ok(JobState::Running {
        pid: Some(pid),
        age_secs: Some(0),
        workdir: None,
    })
}

impl super::Jobs for Jobs {
    fn show(&self, _: &str) -> Result<JobState, String> {
        self.0.lock().unwrap().state.clone()
    }
    fn start_server(&self, _: &ServerJob) -> Result<(), String> {
        let mut f = self.0.lock().unwrap();
        f.starts += 1;
        f.state = running(100 + f.starts);
        Ok(())
    }
    fn start_session(&self, _: &SessionJob) -> Result<(), String> {
        Err("no sessions here".into())
    }
    fn stop(&self, _: &str) -> Result<(), String> {
        self.0.lock().unwrap().state = Ok(JobState::Gone);
        Ok(())
    }
    fn clear(&self, _: &str) {
        let mut f = self.0.lock().unwrap();
        f.clears += 1;
        f.state = Ok(JobState::Gone);
    }
    fn running(&self, _: &str) -> Result<Vec<Listed>, String> {
        Ok(Vec::new())
    }
}

/// A supervisor over fake jobs in `state`, and the clock it reads.
fn rig(tag: &str, state: Result<JobState, String>) -> (Supervisor, Jobs, Arc<Mutex<Instant>>) {
    let dir = std::env::temp_dir().join(format!("daedalus-sup-{tag}-{}", std::process::id()));
    let _ = std::fs::create_dir_all(&dir);
    let jobs = Jobs(Arc::new(Mutex::new(Fake {
        state,
        starts: 0,
        clears: 0,
    })));
    let now = Arc::new(Mutex::new(Instant::now()));
    let clock = {
        let now = Arc::clone(&now);
        Box::new(move || *now.lock().unwrap())
    };
    let sup = Supervisor::with(
        Box::new(jobs.clone()),
        clock,
        // A claude that is never run: the fake starts nothing.
        Some(PathBuf::from("daedalus-test-no-claude")),
        Some(dir.display().to_string()),
        dir.join("claude-rc.log"),
        true,
        format!("daedalus-agent-test-{tag}"),
        dir.join("gcroots"),
    );
    (sup, jobs, now)
}

fn advance(now: &Mutex<Instant>, secs: u64) {
    *now.lock().unwrap() += Duration::from_secs(secs);
}

#[test]
fn a_quick_exit_backs_off_and_a_long_run_does_not() {
    let (mut sup, jobs, now) = rig("backoff", Ok(JobState::Gone));
    sup.tick();
    assert_eq!(jobs.starts(), 1, "the first tick starts it");
    // It dies within a second, saying why: a failure, five seconds
    // doubled. Its words are the report's `last_line`, never the
    // summary's.
    {
        use std::io::Write;
        let mut log = OpenOptions::new().append(true).open(&sup.log_path).unwrap();
        writeln!(log, "Error: no login in /home/ana/.claude").unwrap();
    }
    jobs.set(Ok(JobState::Exited("1".into())));
    advance(&now, 2);
    sup.tick();
    assert!(sup.server_pid().is_none() && sup.failures == 1);
    let r = sup.report();
    assert_eq!(r.state, "waiting");
    assert_eq!(
        r.last_line.as_deref(),
        Some("Error: no login in /home/ana/.claude")
    );
    assert!(!r.summary().detail.unwrap().contains("/home/ana"));
    advance(&now, 9);
    sup.tick();
    assert_eq!(jobs.starts(), 1, "still backing off");
    advance(&now, 2);
    sup.tick();
    assert_eq!(jobs.starts(), 2);
    // This one runs past QUICK_EXIT, then exits: no failure, two seconds.
    advance(&now, 11);
    sup.tick();
    assert_eq!(sup.server_pid(), Some(102));
    advance(&now, 60);
    jobs.set(Ok(JobState::Exited("0".into())));
    sup.tick();
    assert_eq!(sup.failures, 0);
    advance(&now, 1);
    sup.tick();
    assert_eq!(jobs.starts(), 2);
    advance(&now, 2);
    sup.tick();
    assert_eq!(jobs.starts(), 3);
    assert_eq!(sup.starts(), 3);
}

#[test]
fn an_unknown_state_is_never_taken_for_gone() {
    // At attach: nothing starts while the OS cannot say.
    let (mut sup, jobs, now) = rig("unknown", Err("launchctl: no answer".into()));
    sup.tick();
    advance(&now, 2);
    sup.tick();
    assert_eq!(jobs.starts(), 0);
    advance(&now, 2);
    sup.tick();
    assert_eq!(jobs.starts(), 0, "asked again, still unknown");
    // Gone at last: started the next time it is asked.
    jobs.set(Ok(JobState::Gone));
    advance(&now, 4);
    sup.tick();
    assert_eq!(jobs.starts(), 1);
    advance(&now, 2);
    sup.tick();
    // While it runs: an unknown answer is not an exit.
    jobs.set(Err("launchctl: no answer".into()));
    for _ in 0..5 {
        advance(&now, 11);
        sup.tick();
    }
    assert_eq!(jobs.starts(), 1);
    assert_eq!(sup.server_pid(), Some(101));
    assert_eq!(jobs.0.lock().unwrap().clears, 1, "only the start cleared");
}

#[test]
fn a_job_left_running_is_adopted_not_restarted() {
    let (mut sup, jobs, now) = rig("adopt", running(42));
    assert_eq!(sup.server_pid(), Some(42));
    for _ in 0..3 {
        advance(&now, 11);
        sup.tick();
    }
    assert_eq!((jobs.starts(), sup.starts()), (0, 0));
    // Not wanted any more: stopped, and nothing starts again.
    sup.set_wanted(false);
    advance(&now, 60);
    sup.tick();
    assert_eq!(jobs.starts(), 0);
    assert!(sup.server_pid().is_none());
}
