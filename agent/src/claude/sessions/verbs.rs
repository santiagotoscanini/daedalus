//! The three verbs on one session, as the sessions' thread runs them
//! (the module doc, sessions/mod.rs, has their rules): the CLI calls they
//! make, and how each one ends (`Outcome`).

use std::path::Path;
use std::process::Command;

use super::worker::Worker;
use super::{AGENTS_TIMEOUT, SETTLE, VERB_TIMEOUT};
use crate::claude::profile::{claude_dir, home_dir, read_session_files};
use crate::claude::roster::{self, is_uuid, Agent};
use crate::claude::workdir::trusted_projects;
use crate::claude::{cli::find_cli, gcroot, ActionState};
use crate::core::state::now_rfc3339;
use crate::jobs::{self as job, JobState, SessionJob};
use crate::os::jobs;

/// `claude agents --json`, or None when it did not answer with an array.
pub(super) fn agents(cli: Option<&Path>) -> Option<Vec<Agent>> {
    let mut cmd = Command::new(cli?);
    cmd.args(["agents", "--json"]);
    let out = crate::exec::stdout_or(cmd, AGENTS_TIMEOUT, crate::exec::Text::Lossy).ok()?;
    roster::parse_agents(&out)
}

/// `claude <verb> <id>`; its output goes to the agent's log alone.
fn claude_verb(cli: &Path, verb: &str, id: &str) {
    let mut cmd = Command::new(cli);
    cmd.args([verb, id]);
    match crate::exec::both(cmd, VERB_TIMEOUT) {
        Some(r) => tracing::info!(
            verb,
            id,
            ok = r.ok,
            output = %r.output.chars().take(400).collect::<String>(),
            "claude {verb} ran"
        ),
        None => tracing::warn!(
            verb,
            id,
            "claude {verb} did not finish in time and was killed"
        ),
    }
}

fn background<'a>(agents: &'a [Agent], id: &str) -> Option<&'a Agent> {
    agents
        .iter()
        .find(|a| a.id.as_deref() == Some(id) && a.kind.as_deref() == Some("background"))
}

/// A verb's outcome before it is recorded.
pub(super) struct Outcome(pub(super) ActionState, pub(super) String);

pub(super) fn refused(why: impl Into<String>) -> Outcome {
    Outcome(ActionState::Refused, why.into())
}

pub(super) fn failed(why: impl Into<String>) -> Outcome {
    Outcome(ActionState::Failed, why.into())
}

pub(super) fn done(what: impl Into<String>) -> Outcome {
    Outcome(ActionState::Done, what.into())
}

impl Worker {
    fn job_of(&self, id: &str) -> String {
        format!("{}{id}", self.ctx.prefix)
    }

    pub(super) fn resume(&self, id: &str) -> Outcome {
        let name = self.job_of(id);
        let Some(dir) = claude_dir() else {
            return failed("no Claude profile directory (no HOME)");
        };
        // Layer 2: the tree answers for the uuid, by the directory's name.
        let Some(project) = roster::find_transcript(&dir.join("projects"), id) else {
            return refused(format!(
                "no transcript for {id} under ~/.claude/projects: there is nothing to resume"
            ));
        };
        // Layer 3: that name must be the slug of a trusted directory, which
        // is where the session runs — composed from the trusted list, never
        // from the tree.
        let Some(cwd) = trusted_projects()
            .into_iter()
            .find(|d| roster::slug(&d.display().to_string()) == project)
        else {
            return refused(format!(
                "that session ran in {}, whose workspace trust has never been accepted: \
                 a resumed session would stop on the trust prompt with nobody to answer it",
                roster::unslug(&project)
            ));
        };
        if let Ok(JobState::Running { .. }) = self.jobs.show(&name) {
            return refused(format!(
                "{id} is already running as {name}: resuming it again would start a second process on the same transcript"
            ));
        }
        let cli = find_cli();
        let Some(listed) = agents(cli.as_deref()) else {
            return refused(
                "claude agents --json did not answer, so whether this session already runs cannot be told",
            );
        };
        if listed.iter().any(|a| a.session_id.as_deref() == Some(id)) {
            return refused(format!(
                "{id} is already running (claude agents reports it): a resume would start a copy, not attach"
            ));
        }
        if roster::session_live(&read_session_files(&dir), id) {
            return refused(format!(
                "{id} already has a live process behind it: a resume would start a copy, not attach"
            ));
        }
        let Some(cli) = cli else {
            return failed("no `claude` command on this machine");
        };
        let log = self.ctx.log_dir.join(format!("{name}.log"));
        if let Err(e) = std::fs::create_dir_all(&self.ctx.log_dir).and_then(|()| {
            use std::io::Write;
            let mut f = std::fs::OpenOptions::new()
                .create(true)
                .append(true)
                .open(&log)?;
            writeln!(
                f,
                "── {} daedalus-agent resuming {id} in {} (job {name}) ──",
                now_rfc3339(),
                cwd.display()
            )
        }) {
            return failed(format!("the log {} was not opened: {e}", log.display()));
        }
        let path = std::env::var("PATH").ok();
        let config_dir = std::env::var("CLAUDE_CONFIG_DIR").ok();
        let env = job::session_env(
            jobs::server_env(
                home_dir().as_deref(),
                path.as_deref(),
                config_dir.as_deref(),
            ),
            Path::new("/run/wrappers/bin").is_dir(),
            self.jobs.session_shell().as_deref(),
        );
        let started = self.jobs.start_session(&SessionJob {
            name: &name,
            id,
            cli: &cli,
            label: &self.ctx.label,
            cwd: &cwd,
            log: &log,
            env: &env,
        });
        if let Err(e) = started {
            return failed(format!("{name} was not started: {e}"));
        }
        gcroot::pin(&self.ctx.roots, &name, &cli);
        // "Started" is only "exec'd": the failure worth catching is the CLI
        // leaving at once (a transcript it will not open, a login that
        // expired, a prompt nobody predicted).
        std::thread::sleep(SETTLE);
        match self.jobs.show(&name) {
            Ok(JobState::Running { .. }) => done(format!(
                "resumed {id} in {} as {name}; it appears on claude.ai within a few seconds",
                cwd.display()
            )),
            Ok(other) => failed(format!(
                "{name} is {} five seconds after starting: the session did not come up; see {}",
                match other {
                    JobState::Exited(code) => format!("exited ({code})"),
                    _ => "gone".into(),
                },
                log.display()
            )),
            Err(e) => failed(format!("{name}'s state is unknown after starting it: {e}")),
        }
    }

    pub(super) fn stop(&self, id: &str) -> Outcome {
        if is_uuid(id) {
            let name = self.job_of(id);
            if !matches!(self.jobs.show(&name), Ok(JobState::Running { .. })) {
                return refused(format!(
                    "{id} is not running as {name}, and a session this agent did not resume has \
                     no stop of its own: a Remote Control session ends with its server"
                ));
            }
            if let Err(e) = self.jobs.stop(&name) {
                return failed(format!("{name} was not stopped: {e}"));
            }
            return match self.jobs.show(&name) {
                Ok(JobState::Running { .. }) => failed(format!("{name} still runs after the stop")),
                _ => {
                    self.jobs.clear(&name);
                    done(format!(
                        "stopped {id}; its transcript is intact and it can be resumed again"
                    ))
                }
            };
        }
        // A background agent: the CLI's own list is the allowlist.
        let cli = find_cli();
        let Some(listed) = agents(cli.as_deref()) else {
            return refused(
                "claude agents --json did not answer; there is no list to find the agent in",
            );
        };
        if background(&listed, id).is_none() {
            return refused(format!(
                "no background agent {id}: claude agents does not list one, so there is nothing for claude stop to end"
            ));
        }
        let Some(cli) = cli else {
            return failed("no `claude` command on this machine");
        };
        claude_verb(&cli, "stop", id);
        // What settles it is the process, not the record (the record stays
        // on purpose) and not the CLI's exit status.
        let after = agents(Some(&cli)).unwrap_or_default();
        match background(&after, id).and_then(|a| a.pid) {
            Some(pid) if crate::os::pid_alive(pid) => failed(format!(
                "background agent {id} still has a live process (pid {pid}) after claude stop"
            )),
            _ => done(format!(
                "stopped background agent {id}; nothing runs behind it. Its conversation is kept: \
                 claude attach reopens it, and remove deletes the record"
            )),
        }
    }

    pub(super) fn remove(&self, id: &str) -> Outcome {
        let cli = find_cli();
        let Some(listed) = agents(cli.as_deref()) else {
            return refused(
                "claude agents --json did not answer; there is no list to find the record in",
            );
        };
        if background(&listed, id).is_none() {
            return refused(format!(
                "no background agent {id}: claude agents does not list one, so there is no record to remove"
            ));
        }
        let Some(cli) = cli else {
            return failed("no `claude` command on this machine");
        };
        claude_verb(&cli, "rm", id);
        match agents(Some(&cli)) {
            None => failed(format!(
                "claude agents --json did not answer after claude rm; whether {id} is gone cannot be told"
            )),
            Some(after) if background(&after, id).is_some() => failed(format!(
                "claude agents still lists background agent {id} after claude rm: the record was not deleted"
            )),
            Some(_) => done(format!(
                "removed background agent {id}; its record and worktree are gone"
            )),
        }
    }
}
