//! stderr, one line per record, no timestamps: under systemd, journald adds
//! those. When stderr is the journal (`JOURNAL_STREAM`), each line carries a
//! `<N>` syslog priority prefix so journald files it at the right level.
//! `SESSION_HOST_LOG` = off|error|warn|info|debug|trace (default info).
//!
//! Control characters in a record are escaped (`\n` as the two characters
//! `\` `n`): records carry remote strings (paths, a cwd), and a newline in
//! one would otherwise forge a line — and, under journald, its priority.

use std::io::Write;

struct Logger {
    journal: bool,
}

/// Install the logger, once for the life of the process.
pub fn install() {
    let level = match std::env::var("SESSION_HOST_LOG").as_deref() {
        Ok("off") => log::LevelFilter::Off,
        Ok("error") => log::LevelFilter::Error,
        Ok("warn") => log::LevelFilter::Warn,
        Ok("debug") => log::LevelFilter::Debug,
        Ok("trace") => log::LevelFilter::Trace,
        _ => log::LevelFilter::Info,
    };
    let logger = Logger {
        journal: std::env::var_os("JOURNAL_STREAM").is_some(),
    };
    if log::set_logger(Box::leak(Box::new(logger))).is_ok() {
        log::set_max_level(level);
    }
}

impl log::Log for Logger {
    fn enabled(&self, metadata: &log::Metadata) -> bool {
        metadata.level() <= log::max_level()
    }

    fn log(&self, record: &log::Record) {
        if !self.enabled(record.metadata()) {
            return;
        }
        let module = record.target().split("::").next().unwrap_or("");
        let text = escape_controls(&record.args().to_string());
        let line = if self.journal {
            let priority = match record.level() {
                log::Level::Error => 3,
                log::Level::Warn => 4,
                log::Level::Info => 6,
                log::Level::Debug | log::Level::Trace => 7,
            };
            format!("<{priority}>{module}: {text}\n")
        } else {
            format!("{} {module}: {text}\n", record.level())
        };
        // One write per record so lines never interleave; a closed stderr is
        // not worth dying over.
        let _ = std::io::stderr().lock().write_all(line.as_bytes());
    }

    fn flush(&self) {}
}

/// `s` with every control character escaped as Rust would (`\n`, `\u{1b}`).
fn escape_controls(s: &str) -> String {
    if !s.chars().any(char::is_control) {
        return s.to_string();
    }
    let mut out = String::with_capacity(s.len() + 8);
    for c in s.chars() {
        if c.is_control() {
            out.extend(c.escape_default());
        } else {
            out.push(c);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    #[test]
    fn control_characters_cannot_forge_a_line() {
        assert_eq!(super::escape_controls("plain /p/ä"), "plain /p/ä");
        assert_eq!(
            super::escape_controls("/p/x\n<3>forged\u{1b}[31m"),
            "/p/x\\n<3>forged\\u{1b}[31m"
        );
    }
}
