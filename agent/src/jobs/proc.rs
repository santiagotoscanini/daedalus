//! What the OS says a job's process costs: `/proc/<pid>/stat`, systemd's
//! accounting, and the units that are running.

use serde::{Deserialize, Serialize};

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UnitCost {
    pub memory_bytes: Option<u64>,
    pub cpu_nsec: Option<u64>,
}

/// What `/proc/<pid>/stat` says of a process: its parent, its start time in
/// clock ticks since boot, and its user and system time in ticks.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct ProcStat {
    pub ppid: u32,
    pub start_ticks: u64,
    pub utime: u64,
    pub stime: u64,
}

/// `/proc/<pid>/stat`: `comm` is parenthesised and may hold spaces and
/// parens, so everything through the LAST `)` goes first; the rest starts
/// at field 3 (state), which puts ppid at 4 and utime, stime and starttime
/// at 14, 15 and 22.
pub fn parse_proc_stat(text: &str) -> Option<ProcStat> {
    let rest = &text[text.rfind(')')? + 1..];
    let f: Vec<&str> = rest.split_whitespace().collect();
    Some(ProcStat {
        ppid: f.get(1)?.parse().ok()?,
        utime: f.get(11)?.parse().ok()?,
        stime: f.get(12)?.parse().ok()?,
        start_ticks: f.get(19)?.parse().ok()?,
    })
}

/// A process as the OS reads it (os `process_stats`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcStats {
    pub start_ticks: u64,
    pub cpu_ms: u64,
    pub rss_bytes: u64,
    /// Its command line, argument by argument.
    pub args: Vec<String>,
}

/// `systemctl --user show -p MemoryCurrent -p CPUUsageNSec`: systemd writes
/// accounting it lacks as `[not set]` or the u64 sentinel, both null here.
pub fn parse_unit_cost(text: &str) -> UnitCost {
    let get = |k: &str| {
        text.lines()
            .find_map(|l| l.strip_prefix(k)?.strip_prefix('='))
            .and_then(|v| v.trim().parse::<u64>().ok())
            .filter(|v| *v != u64::MAX)
    };
    UnitCost {
        memory_bytes: get("MemoryCurrent"),
        cpu_nsec: get("CPUUsageNSec"),
    }
}

/// `systemctl --user list-units --type=service --all --no-legend --plain
/// '<prefix>*.service'`: the names (without `.service`) of the units that
/// are active or activating.
pub fn parse_running_units(text: &str, prefix: &str) -> Vec<String> {
    text.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            let (unit, active) = (*f.first()?, *f.get(2)?);
            if !matches!(active, "active" | "activating") {
                return None;
            }
            let name = unit.strip_suffix(".service")?;
            name.starts_with(prefix).then(|| name.to_string())
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn proc_stat_units_and_their_costs() {
        let stat = "4242 (claude (x) y) S 1 4242 4242 0 -1 4194560 100 0 0 0 250 50 0 0 20 0 12 0 987654 1000 200 18446744073709551615";
        assert_eq!(
            parse_proc_stat(stat),
            Some(ProcStat {
                ppid: 1,
                utime: 250,
                stime: 50,
                start_ticks: 987654
            })
        );
        assert_eq!(parse_proc_stat("4242 (x) S 1"), None);
        assert_eq!(
            parse_unit_cost("MemoryCurrent=1048576\nCPUUsageNSec=[not set]\n"),
            UnitCost {
                memory_bytes: Some(1_048_576),
                cpu_nsec: None
            }
        );
        assert_eq!(
            parse_unit_cost("MemoryCurrent=18446744073709551615\n").memory_bytes,
            None
        );
        let units = "claude-session-abdda3a9-0cb2-43f1-b13e-37f25a755fce.service loaded active running Claude\n\
                     claude-session-bbdda3a9-0cb2-43f1-b13e-37f25a755fce.service loaded failed failed Claude\n\
                     claude-session-x.service loaded active running Claude\n\
                     claude-session-cbdda3a9-0cb2-43f1-b13e-37f25a755fce.service loaded activating start Claude\n";
        assert_eq!(
            parse_running_units(units, "claude-session-"),
            [
                "claude-session-abdda3a9-0cb2-43f1-b13e-37f25a755fce",
                "claude-session-x",
                "claude-session-cbdda3a9-0cb2-43f1-b13e-37f25a755fce"
            ]
        );
    }
}
