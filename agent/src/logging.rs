//! The agent's log: a daily-rotated file, plus the terminal in the
//! foreground.

use std::path::Path;

use anyhow::{Context, Result};
use tracing_appender::non_blocking::WorkerGuard;

use crate::config::Config;
use crate::paths::log_dir;

/// Daily-rotated file log, plus the terminal when running in the foreground.
/// The guard flushes the file writer when dropped, so the caller keeps it
/// for the life of the process.
pub fn init_logging(cfg: &Config, foreground: bool) -> Result<WorkerGuard> {
    init_logging_to(cfg, &log_dir(), "agent.log", foreground)
}

/// The same, into `dir/<name>.<date>`: the headless session logs as its
/// user, into `user_log_dir`, as `session.log`.
pub fn init_logging_to(
    cfg: &Config,
    dir: &Path,
    name: &str,
    foreground: bool,
) -> Result<WorkerGuard> {
    use tracing_subscriber::layer::SubscriberExt;
    use tracing_subscriber::util::SubscriberInitExt;
    use tracing_subscriber::{fmt, EnvFilter};
    std::fs::create_dir_all(dir).context("creating the log directory")?;
    let file = tracing_appender::rolling::daily(dir, name);
    let (writer, guard) = tracing_appender::non_blocking(file);
    let filter = EnvFilter::try_new(&cfg.log_level).unwrap_or_else(|_| EnvFilter::new("info"));
    let to_file = fmt::layer()
        .with_writer(writer)
        .with_ansi(false)
        .with_target(false);
    let to_terminal =
        foreground.then(|| fmt::layer().with_writer(std::io::stderr).with_target(false));
    tracing_subscriber::registry()
        .with(filter)
        .with(to_file)
        .with(to_terminal)
        .init();
    Ok(guard)
}
