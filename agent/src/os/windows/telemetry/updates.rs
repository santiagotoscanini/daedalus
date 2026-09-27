//! The hourly tier: what Windows Update has pending (the
//! `Microsoft.Update.Session` search) and the last hotfixes installed,
//! from one PowerShell script, plus the reboot-pending flag from the two
//! registry keys servicing leaves behind.

use serde_json::Value;
use windows::core::{w, PCWSTR};

use super::powershell::{j_id, j_list, j_str, j_u64, powershell_json, script_errors};
use super::registry::reg_key_exists;
use super::{collapse_ws, UPDATES_DEADLINE};
use crate::telemetry::{Installed, Update, Updates};

/// The two keys servicing leaves behind while a restart is owed.
const REBOOT_WU: PCWSTR =
    w!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\WindowsUpdate\Auto Update\RebootRequired");
const REBOOT_CBS: PCWSTR =
    w!(r"SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending");

/// The hourly script: what Windows Update has pending, through the same
/// COM agent the Settings page uses, and the last few hotfixes installed.
/// Dates are formatted in the script because `ConvertTo-Json` would
/// render them as `/Date(ms)/`.
const UPDATES_SCRIPT: &str = r"
$ErrorActionPreference = 'Stop'
$out = @{ pending = @(); installed = @(); errors = @() }
try {
  $s = New-Object -ComObject Microsoft.Update.Session
  $r = $s.CreateUpdateSearcher().Search('IsInstalled=0 and IsHidden=0')
  $out.pending = @($r.Updates | ForEach-Object { [pscustomobject]@{
    title = $_.Title; kb = ($_.KBArticleIDs | Select-Object -First 1); size = $_.MaxDownloadSize;
    severity = $_.MsrcSeverity; restart = $_.RebootRequired } })
} catch { $out.errors += ('search|' + $_.Exception.Message) }
try {
  $out.installed = @(Get-HotFix | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending | Select-Object -First 8 |
    ForEach-Object { [pscustomobject]@{ id = $_.HotFixID; description = $_.Description; at = $_.InstalledOn.ToString('yyyy-MM-dd') } })
} catch { $out.errors += ('hotfix|' + $_.Exception.Message) }
[pscustomobject]$out | ConvertTo-Json -Compress -Depth 4
";

/// The severity as the page says it; the COM object gives "" for none.
fn severity_name(s: &str) -> Option<String> {
    let l = s.trim().to_ascii_lowercase();
    (!l.is_empty()).then_some(l)
}

/// "KB5043076" from whatever the KB number came as.
fn kb_id(s: &str) -> Option<String> {
    let t = s.trim();
    let digits = t
        .strip_prefix("KB")
        .or_else(|| t.strip_prefix("kb"))
        .unwrap_or(t);
    (!digits.is_empty() && digits.chars().all(|c| c.is_ascii_digit()))
        .then(|| format!("KB{digits}"))
}

/// The updates document from the hourly script's output.
fn parse_updates(v: &Value) -> Updates {
    let pending = j_list(v, "pending")
        .iter()
        .filter_map(|u| {
            Some(Update {
                title: collapse_ws(&j_str(u, "title")?),
                id: j_id(u, "kb").and_then(|k| kb_id(&k)),
                size_bytes: j_u64(u, "size").filter(|&b| b > 0),
                severity: j_str(u, "severity").and_then(|s| severity_name(&s)),
                restart: u.get("restart").and_then(Value::as_bool),
            })
        })
        .collect();
    let installed = j_list(v, "installed")
        .iter()
        .filter_map(|h| {
            let id = j_str(h, "id")?;
            let title = match j_str(h, "description") {
                Some(d) => format!("{id} {d}"),
                None => id,
            };
            Some(Installed {
                title,
                at: j_str(h, "at"),
            })
        })
        .collect();
    let errors = script_errors(v, |what| {
        match what {
            "search" => "Windows Update search",
            "hotfix" => "installed updates",
            _ => "OS updates",
        }
        .to_string()
    });
    Updates {
        checked_at: None,
        pending,
        installed,
        reboot_pending: None,
        error: errors.into_iter().next(),
    }
}

/// What Windows Update has pending and recently installed, on the hourly
/// thread: the COM search through PowerShell, the reboot flag from the
/// registry. A failed search leaves `error` set and whatever else was read.
pub fn read_updates() -> Updates {
    let mut u = match powershell_json(UPDATES_SCRIPT, UPDATES_DEADLINE) {
        Ok(v) => parse_updates(&v),
        Err(e) => Updates {
            error: Some(format!("Windows Update search: {e}")),
            ..Default::default()
        },
    };
    u.checked_at = Some(crate::state::now_rfc3339());
    u.reboot_pending = Some(reg_key_exists(REBOOT_WU) || reg_key_exists(REBOOT_CBS));
    u
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn updates_from_script_document() {
        let v: Value = serde_json::from_str(
            r#"{
              "pending": {"title":"2025-09 Cumulative Update  (KB5043076)","kb":"5043076","size":734003200,"severity":"Important","restart":true},
              "installed": [
                {"id":"KB5041585","description":"Security Update","at":"2025-08-14"},
                {"id":"KB5039895","description":null,"at":"2025-07-10"}
              ],
              "errors": []
            }"#,
        )
        .expect("json");
        let u = parse_updates(&v);
        assert_eq!(u.pending.len(), 1);
        assert_eq!(u.pending[0].title, "2025-09 Cumulative Update (KB5043076)");
        assert_eq!(u.pending[0].id.as_deref(), Some("KB5043076"));
        assert_eq!(u.pending[0].size_bytes, Some(734_003_200));
        assert_eq!(u.pending[0].severity.as_deref(), Some("important"));
        assert_eq!(u.pending[0].restart, Some(true));
        assert_eq!(u.installed.len(), 2);
        assert_eq!(u.installed[0].title, "KB5041585 Security Update");
        assert_eq!(u.installed[0].at.as_deref(), Some("2025-08-14"));
        assert_eq!(u.installed[1].title, "KB5039895");
        assert_eq!(u.error, None);
        let failed: Value =
            serde_json::from_str(r#"{"pending":[],"installed":[],"errors":["search|0x80240438"]}"#)
                .expect("json");
        let u = parse_updates(&failed);
        assert!(u.pending.is_empty());
        assert_eq!(
            u.error.as_deref(),
            Some("Windows Update search: search refused: 0x80240438")
        );
    }

    #[test]
    fn kb_ids() {
        assert_eq!(kb_id("5043076"), Some("KB5043076".into()));
        assert_eq!(kb_id("KB5043076"), Some("KB5043076".into()));
        assert_eq!(kb_id("n/a"), None);
    }
}
