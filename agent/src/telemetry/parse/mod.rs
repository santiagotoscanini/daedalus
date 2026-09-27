//! The telemetry's pure parsers: text or bytes in, the document's types
//! out, no OS call anywhere — so every one is compiled and tested on every
//! OS, and a collector on any OS may use any of them.
//!
//! - `smbios`: the raw SMBIOS table (chassis type, memory arrays and
//!   modules), from `GetSystemFirmwareTable` on Windows — and the same
//!   bytes any OS's firmware interface hands over;
//! - `system_profiler`: macOS's `system_profiler -json` documents;
//! - `macos_tools`: the text of `launchctl`, `vm_stat`, `ps`, `df`,
//!   `mount`, `diskutil`, `ioreg`, `powermetrics`, `netstat`, `pmset`, and
//!   the plist helpers;
//! - here: the string cleanup firmware and cmdlet strings need.

pub mod macos_tools;
pub mod smbios;
pub mod system_profiler;

/// Runs of whitespace as one space, trimmed.
pub fn collapse_ws(s: &str) -> String {
    s.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// A firmware or cmdlet string worth showing: trimmed, and not one of the
/// placeholders boards ship with instead of a value.
pub fn meaningful(s: &str) -> Option<String> {
    let t = collapse_ws(s);
    if t.is_empty() {
        return None;
    }
    let l = t.to_ascii_lowercase();
    let placeholder = matches!(
        l.as_str(),
        "unknown"
            | "not specified"
            | "none"
            | "n/a"
            | "no dimm"
            | "undefined"
            | "not available"
            | "to be filled by o.e.m."
            | "default string"
            | "empty"
    );
    (!placeholder).then_some(t)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_and_placeholders() {
        assert_eq!(meaningful("  To Be Filled By O.E.M. "), None);
        assert_eq!(meaningful("Unknown"), None);
        assert_eq!(meaningful(" Kingston  "), Some("Kingston".into()));
        assert_eq!(
            collapse_ws("Intel(R)   Core(TM)  i9"),
            "Intel(R) Core(TM) i9"
        );
    }
}
