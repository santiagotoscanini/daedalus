//! What the OS says a job's process costs: a process as `os::process_stats`
//! reads it, systemd's accounting, and the units that are running.

use serde::{Deserialize, Serialize};

#[cfg_attr(test, derive(ts_rs::TS))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(default)]
pub struct UnitCost {
    pub memory_bytes: Option<u64>,
    pub cpu_nsec: Option<u64>,
}

/// A process as the OS reads it (os `process_stats`).
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ProcStats {
    /// When it started, in the form a Claude session file's `procStart`
    /// records it — clock ticks since boot, which only Linux's CLI writes
    /// as a number (macOS's is `ps -o lstart`, Windows' another field). None
    /// where the two cannot be compared.
    pub start_ticks: Option<u64>,
    pub cpu_ms: u64,
    pub rss_bytes: u64,
    /// Its command line, argument by argument (empty where it is not read).
    pub args: Vec<String>,
}

/// The arguments in a `KERN_PROCARGS2` buffer (macOS): the argument count
/// as a native-endian int, the executable's path, NUL padding, then the
/// arguments, each NUL-terminated, then the environment — never read. At
/// most `max`.
pub fn parse_procargs2(buf: &[u8], max: usize) -> Vec<String> {
    let Some(count) = buf.get(..4).and_then(|b| b.try_into().ok()) else {
        return Vec::new();
    };
    let argc = usize::try_from(i32::from_ne_bytes(count)).unwrap_or(0);
    let rest = &buf[4..];
    // Past the executable's path and the padding after it.
    let Some(path_end) = rest.iter().position(|b| *b == 0) else {
        return Vec::new();
    };
    let Some(start) = rest[path_end..].iter().position(|b| *b != 0) else {
        return Vec::new();
    };
    rest[path_end + start..]
        .split(|b| *b == 0)
        .take(argc.min(max))
        .map(|a| String::from_utf8_lossy(a).into_owned())
        .collect()
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

/// A job that runs, as one listing of them says: its name, its main pid,
/// and its cost where the OS accounts for it.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Listed {
    pub name: String,
    pub pid: Option<u32>,
    pub cost: UnitCost,
}

/// `systemctl --user show -p Id,ActiveState,MainPID,MemoryCurrent,CPUUsageNSec
/// '<prefix>*.service'`: one block of `Key=value` lines per loaded unit, the
/// blocks apart by an empty line. The units whose name starts with `prefix`
/// that are active or activating, with their pid and cost: one call for
/// every resumed session.
pub fn parse_systemd_units(text: &str, prefix: &str) -> Vec<Listed> {
    text.split("\n\n")
        .filter_map(|block| {
            let get = |k: &str| {
                block
                    .lines()
                    .find_map(|l| l.strip_prefix(k)?.strip_prefix('='))
                    .map(str::trim)
            };
            if !matches!(get("ActiveState")?, "active" | "activating") {
                return None;
            }
            let name = get("Id")?.strip_suffix(".service")?;
            name.starts_with(prefix).then(|| Listed {
                name: name.to_string(),
                pid: get("MainPID")
                    .and_then(|p| p.parse::<u32>().ok())
                    .filter(|p| *p > 0),
                cost: parse_unit_cost(block),
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn units_their_costs_and_a_macos_command_line() {
        let mut args2 = 3i32.to_ne_bytes().to_vec();
        args2.extend_from_slice(b"/opt/claude\0\0\0\0claude\0--resume\0cse_01\0HOME=/x\0");
        assert_eq!(
            parse_procargs2(&args2, 64),
            ["claude", "--resume", "cse_01"]
        );
        assert_eq!(parse_procargs2(&args2, 1), ["claude"]);
        assert!(parse_procargs2(b"\x01", 64).is_empty());
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
        let units = "Id=claude-session-a.service\nActiveState=active\nMainPID=4242\nMemoryCurrent=1048576\nCPUUsageNSec=[not set]\n\n\
                     Id=claude-session-b.service\nActiveState=failed\nMainPID=0\n\n\
                     MainPID=17\nId=claude-session-c.service\nCPUUsageNSec=5\nActiveState=activating\n\n\
                     Id=other.service\nActiveState=active\nMainPID=9\n";
        assert_eq!(
            parse_systemd_units(units, "claude-session-"),
            [
                Listed {
                    name: "claude-session-a".into(),
                    pid: Some(4242),
                    cost: UnitCost {
                        memory_bytes: Some(1_048_576),
                        cpu_nsec: None
                    }
                },
                Listed {
                    name: "claude-session-c".into(),
                    pid: Some(17),
                    cost: UnitCost {
                        memory_bytes: None,
                        cpu_nsec: Some(5)
                    }
                },
            ]
        );
    }
}
