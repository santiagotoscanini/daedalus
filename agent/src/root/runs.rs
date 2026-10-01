//! The controller's memory of root runs: what each one printed and how it
//! ended, kept after its caller stopped listening. The helper only relays to
//! the connection that asked; a page opened mid-run, or one whose request was
//! answered the moment the unit started (`root.run` with `detach`), reads the
//! run here instead (`root.follow`, `root.runs`). Bounded per run
//! (`MAX_LINES`, `MAX_BYTES`, the oldest lines go first) and in time (a
//! finished run is forgotten after `KEEP`, and at most `MAX_RUNS` are kept).
//! In memory only: a controller restart forgets them, while the units, their
//! status files and their journal keep the record that matters.

use std::collections::VecDeque;
use std::sync::{Condvar, Mutex};
use std::time::{Duration, Instant};

use crate::util::LockExt;

use super::Outcome;

/// Lines kept per run, the newest.
pub const MAX_LINES: usize = 2000;
/// Bytes of line text kept per run, the newest.
pub const MAX_BYTES: usize = 1 << 20;
/// How long a finished run is kept.
pub const KEEP: Duration = Duration::from_secs(60 * 60);
/// Runs kept at once; past it the oldest finished one goes.
pub const MAX_RUNS: usize = 64;
/// Lines one `follow` answers with at most.
pub const FOLLOW_PAGE: usize = 500;

/// One run as `root.follow` reads it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Followed {
    pub verb: String,
    /// Lines past `after`, oldest first, each with its number (from 1).
    pub lines: Vec<(u64, String)>,
    /// The number of the last line answered, or `after` when none was.
    pub next: u64,
    /// Lines past `after` were forgotten before this read.
    pub dropped: bool,
    /// More lines are waiting past `next`.
    pub more: bool,
    pub summary: Summary,
}

/// What a run is, without its lines.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Summary {
    pub run: String,
    pub verb: String,
    /// Unix seconds.
    pub started_at: u64,
    pub finished_at: Option<u64>,
    /// The unit was started (the helper said so).
    pub started: bool,
    /// None while it runs.
    pub outcome: Option<Outcome>,
    pub detail: String,
}

struct Run {
    summary: Summary,
    finished: Option<Instant>,
    lines: VecDeque<(u64, String)>,
    bytes: usize,
    last_seq: u64,
}

/// Every run this controller asked for, while it keeps them.
#[derive(Default)]
pub struct Runs {
    runs: Mutex<VecDeque<Run>>,
    moved: Condvar,
}

fn unix_now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl Runs {
    /// A run the controller is about to ask for.
    pub fn begin(&self, run: &str, verb: &str) {
        let mut runs = self.runs.lock_ok();
        prune(&mut runs, Instant::now());
        runs.push_back(Run {
            summary: Summary {
                run: run.into(),
                verb: verb.into(),
                started_at: unix_now(),
                finished_at: None,
                started: false,
                outcome: None,
                detail: String::new(),
            },
            finished: None,
            lines: VecDeque::new(),
            bytes: 0,
            last_seq: 0,
        });
    }

    fn with(&self, run: &str, f: impl FnOnce(&mut Run)) {
        let mut runs = self.runs.lock_ok();
        if let Some(r) = runs.iter_mut().find(|r| r.summary.run == run) {
            f(r);
        }
        self.moved.notify_all();
    }

    /// The helper started the unit.
    pub fn started(&self, run: &str) {
        self.with(run, |r| r.summary.started = true);
    }

    /// One line the unit wrote.
    pub fn line(&self, run: &str, text: &str) {
        self.with(run, |r| {
            r.last_seq += 1;
            r.bytes += text.len();
            r.lines.push_back((r.last_seq, text.to_string()));
            while r.lines.len() > MAX_LINES || r.bytes > MAX_BYTES {
                match r.lines.pop_front() {
                    Some((_, l)) => r.bytes -= l.len(),
                    None => break,
                }
            }
        });
    }

    /// How it ended.
    pub fn finish(&self, run: &str, outcome: Outcome, detail: &str) {
        self.with(run, |r| {
            r.summary.outcome = Some(outcome);
            r.summary.detail = detail.to_string();
            r.summary.finished_at = Some(unix_now());
            r.finished = Some(Instant::now());
        });
    }

    /// Wait until the run started or ended, for at most `wait`: whether it
    /// did. A run this store does not hold never does.
    pub fn wait_started(&self, run: &str, wait: Duration) -> bool {
        let deadline = Instant::now() + wait;
        let mut runs = self.runs.lock_ok();
        loop {
            match runs.iter().find(|r| r.summary.run == run) {
                Some(r) if r.summary.started || r.summary.outcome.is_some() => return true,
                Some(_) => {}
                None => return false,
            }
            let now = Instant::now();
            if now >= deadline {
                return false;
            }
            runs = match self.moved.wait_timeout(runs, deadline - now) {
                Ok((g, _)) => g,
                Err(p) => p.into_inner().0,
            };
        }
    }

    /// The run's lines past `after`, at most `FOLLOW_PAGE`; None for a run
    /// this store does not hold.
    pub fn follow(&self, run: &str, after: u64) -> Option<Followed> {
        let mut runs = self.runs.lock_ok();
        prune(&mut runs, Instant::now());
        let r = runs.iter().find(|r| r.summary.run == run)?;
        let first = r.lines.front().map_or(r.last_seq + 1, |(s, _)| *s);
        let lines: Vec<(u64, String)> = r
            .lines
            .iter()
            .filter(|(s, _)| *s > after)
            .take(FOLLOW_PAGE)
            .cloned()
            .collect();
        let next = lines.last().map_or(after, |(s, _)| *s);
        Some(Followed {
            verb: r.summary.verb.clone(),
            dropped: first > after + 1,
            more: next < r.last_seq,
            next,
            lines,
            summary: r.summary.clone(),
        })
    }

    /// The runs of `verb` this store holds, newest first.
    pub fn of_verb(&self, verb: &str) -> Vec<Summary> {
        let mut runs = self.runs.lock_ok();
        prune(&mut runs, Instant::now());
        runs.iter()
            .rev()
            .filter(|r| r.summary.verb == verb)
            .map(|r| r.summary.clone())
            .collect()
    }
}

/// Forget what finished more than `KEEP` ago, then the oldest finished runs
/// past `MAX_RUNS` (a run still going is never forgotten).
fn prune(runs: &mut VecDeque<Run>, now: Instant) {
    runs.retain(|r| r.finished.is_none_or(|f| now.duration_since(f) < KEEP));
    while runs.len() >= MAX_RUNS {
        match runs.iter().position(|r| r.finished.is_some()) {
            Some(i) => {
                runs.remove(i);
            }
            None => break,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_run_is_followed_from_any_line_and_ends_with_its_outcome() {
        let runs = Runs::default();
        runs.begin("r1", "build");
        assert!(!runs.wait_started("r1", Duration::from_millis(10)));
        runs.started("r1");
        assert!(runs.wait_started("r1", Duration::from_millis(10)));
        for l in ["one", "two", "three"] {
            runs.line("r1", l);
        }
        let f = runs.follow("r1", 0).unwrap();
        assert_eq!(
            f.lines,
            [(1, "one".into()), (2, "two".into()), (3, "three".into())]
        );
        assert_eq!((f.next, f.dropped, f.more), (3, false, false));
        assert_eq!(f.summary.outcome, None);
        // A reader that has line 2 gets what came after it.
        assert_eq!(runs.follow("r1", 2).unwrap().lines, [(3, "three".into())]);
        assert_eq!(runs.follow("r1", 3).unwrap().next, 3);
        runs.finish("r1", Outcome::Refused, "busy");
        let f = runs.follow("r1", 3).unwrap();
        assert_eq!(f.summary.outcome, Some(Outcome::Refused));
        assert_eq!(f.summary.detail, "busy");
        assert!(f.summary.finished_at.is_some());
        assert!(runs.follow("nope", 0).is_none());
        assert!(!runs.wait_started("nope", Duration::from_millis(10)));
    }

    #[test]
    fn lines_bytes_and_runs_are_bounded() {
        let runs = Runs::default();
        runs.begin("r1", "build");
        for i in 0..(MAX_LINES + 10) {
            runs.line("r1", &format!("line {i}"));
        }
        let f = runs.follow("r1", 0).unwrap();
        assert!(f.dropped && f.more);
        assert_eq!(f.lines.len(), FOLLOW_PAGE);
        assert_eq!(f.lines[0].0, 11, "the oldest ten went");
        runs.line("r1", &"x".repeat(MAX_BYTES));
        let f = runs.follow("r1", 0).unwrap();
        assert_eq!(
            f.lines.len(),
            1,
            "one line of the whole budget leaves no other"
        );

        // Past MAX_RUNS the oldest FINISHED run goes; a running one stays.
        for i in 0..MAX_RUNS {
            runs.begin(&format!("f{i}"), "deploy");
            runs.finish(&format!("f{i}"), Outcome::Done, "");
        }
        assert!(runs.follow("r1", 0).is_some());
        assert!(runs.follow("f0", 0).is_none());
        let deploys = runs.of_verb("deploy");
        assert_eq!(deploys[0].run, format!("f{}", MAX_RUNS - 1), "newest first");
        assert!(deploys.len() < MAX_RUNS);
        assert_eq!(runs.of_verb("build").len(), 1);
    }

    #[test]
    fn a_finished_run_is_forgotten_after_keep() {
        let runs = Runs::default();
        runs.begin("old", "image-update");
        runs.finish("old", Outcome::Done, "");
        {
            let mut g = runs.runs.lock_ok();
            let r = g.iter_mut().find(|r| r.summary.run == "old").unwrap();
            // A clock too young to go back an hour has nothing to forget.
            let Some(then) = Instant::now().checked_sub(KEEP + Duration::from_secs(1)) else {
                return;
            };
            r.finished = Some(then);
        }
        assert!(runs.follow("old", 0).is_none());
    }
}
