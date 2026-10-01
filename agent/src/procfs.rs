//! What Linux's `/proc` says about a process, parsed: text in, fields out,
//! no OS call — so it is compiled and tested on every OS. The readers are
//! the OS's (os/linux): the Claude sessions' costs and the process table
//! (`os::process_stats`, `os::process_table`), and the telemetry's process
//! list.

/// `/proc/<pid>/stat`, the fields this agent reads.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Stat {
    pub comm: String,
    pub ppid: u32,
    /// User and system time, clock ticks.
    pub utime: u64,
    pub stime: u64,
    /// When it started, clock ticks since boot: what a Claude session
    /// file's `procStart` records.
    pub start_ticks: u64,
    /// Resident set, pages.
    pub rss_pages: u64,
}

/// `pid (comm) state ppid …`: comm may hold spaces and parentheses, so the
/// fields are counted from the LAST `)`. ppid is field 4, utime and stime 14
/// and 15, starttime 22, rss 24 (proc(5), 1-based).
pub fn parse_stat(text: &str) -> Option<Stat> {
    let open = text.find('(')?;
    let close = text.rfind(')')?;
    let comm = text.get(open + 1..close)?.to_string();
    let rest: Vec<&str> = text.get(close + 1..)?.split_whitespace().collect();
    // rest[0] is field 3 (state).
    let f = |n: usize| rest.get(n - 3).and_then(|x| x.parse::<u64>().ok());
    Some(Stat {
        comm,
        ppid: u32::try_from(f(4)?).ok()?,
        utime: f(14)?,
        stime: f(15)?,
        start_ticks: f(22)?,
        rss_pages: f(24)?,
    })
}

/// `/proc/<pid>/cmdline`: the arguments, NUL-separated, at most `max`.
pub fn parse_cmdline(bytes: &[u8], max: usize) -> Vec<String> {
    bytes
        .split(|c| *c == 0)
        .filter(|a| !a.is_empty())
        .take(max)
        .map(|a| String::from_utf8_lossy(a).into_owned())
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stat_counts_from_the_last_paren() {
        let t = "1234 (Web Content (x)) S 1 1234 1234 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 30 0 \
                 9876 1234567890 5000 18446744073709551615";
        assert_eq!(
            parse_stat(t),
            Some(Stat {
                comm: "Web Content (x)".into(),
                ppid: 1,
                utime: 250,
                stime: 50,
                start_ticks: 9876,
                rss_pages: 5000,
            })
        );
        assert_eq!(parse_stat("garbage"), None);
        assert_eq!(parse_stat("4242 (x) S 1"), None);
        assert_eq!(
            parse_cmdline(b"claude\0--resume\0\0x\0", 2),
            ["claude", "--resume"]
        );
    }
}
