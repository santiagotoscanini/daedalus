//! The telemetry document as Prometheus text: what the controller serves
//! at `/nodes/metrics` for every connected machine (link/controller.rs).

use super::Telemetry;

/// Who a series is about: the four labels every series of a machine
/// carries — the dashboards group and name machines by them.
#[derive(Clone, Copy, Debug)]
pub struct Labels<'a> {
    /// The machine's node id.
    pub node: &'a str,
    /// Its hostname, as its hello gave it.
    pub host: &'a str,
    /// What the pages call it: the operator's name, or the hostname.
    pub machine: &'a str,
    /// Its OS, as its hello gave it.
    pub os: &'a str,
}

impl Labels<'_> {
    /// `host="…",machine="…",node="…",os="…"`, each value escaped.
    pub fn render(&self) -> String {
        format!(
            "host=\"{}\",machine=\"{}\",node=\"{}\",os=\"{}\"",
            escape_label(self.host),
            escape_label(self.machine),
            escape_label(self.node),
            escape_label(self.os)
        )
    }
}

/// A label value, escaped for the exposition format: backslash, quote and
/// newline as the format spells them, every other control character
/// dropped — a name a machine chose must not break a line or forge one.
pub fn escape_label(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '\\' => out.push_str("\\\\"),
            '"' => out.push_str("\\\""),
            '\n' => out.push_str("\\n"),
            c if c.is_control() => {}
            c => out.push(c),
        }
    }
    out
}

/// Prometheus text exposition of one machine's document, every series
/// labelled with `labels`; the page types each family once (`typed`). The
/// OS's own counters (network bytes) carry a counter's `_total` suffix,
/// and a query `rate()`s them.
pub fn metrics_text(t: &Telemetry, agent_version: &str, labels: &Labels) -> String {
    let mut out = String::new();
    let esc = escape_label;
    let base = labels.render();
    let mut gauge = |name: &str, labels: &str, v: f64| {
        let sep = if labels.is_empty() { "" } else { "," };
        out.push_str(&format!(
            "daedalus_agent_{name}{{{base}{sep}{labels}}} {v}\n"
        ));
    };
    gauge(
        "info",
        &format!(
            "version=\"{}\",model=\"{}\",bios=\"{}\",cpu=\"{}\"",
            esc(agent_version),
            esc(t.machine.model.as_deref().unwrap_or("")),
            esc(t.machine.bios_version.as_deref().unwrap_or("")),
            esc(t.cpu.model.as_deref().unwrap_or(""))
        ),
        1.0,
    );
    if let Some(v) = t.cpu.usage_pct {
        gauge("cpu_usage_percent", "", v);
    }
    if let Some(v) = t.cpu.temperature_c {
        gauge("cpu_temperature_celsius", "", v);
    }
    if let Some([a, b, c]) = t.cpu.load {
        gauge("load1", "", a);
        gauge("load5", "", b);
        gauge("load15", "", c);
    }
    for (k, v) in [
        ("memory_total_bytes", t.memory.total_bytes),
        ("memory_used_bytes", t.memory.used_bytes),
        ("memory_available_bytes", t.memory.available_bytes),
        ("memory_cached_bytes", t.memory.cached_bytes),
        ("memory_compressed_bytes", t.memory.compressed_bytes),
        ("memory_committed_bytes", t.memory.committed_bytes),
        ("memory_commit_limit_bytes", t.memory.commit_limit_bytes),
        ("swap_total_bytes", t.memory.swap_total_bytes),
        ("swap_used_bytes", t.memory.swap_used_bytes),
    ] {
        if let Some(v) = v {
            gauge(k, "", v as f64);
        }
    }
    if let Some(v) = t.process_count {
        gauge("processes", "", f64::from(v));
    }
    gauge("services_down", "", t.services.len() as f64);
    for b in &t.browsers {
        gauge(
            "browser_info",
            &format!(
                "browser=\"{}\",version=\"{}\",running=\"{}\"",
                esc(&b.kind),
                esc(b.version.as_deref().unwrap_or("")),
                if b.running { "1" } else { "0" }
            ),
            1.0,
        );
    }
    // One count per kind, in a fixed order so the series set never moves;
    // a kind with nothing installed still reports zero.
    for kind in ["app", "game", "launcher", "runtime", "driver"] {
        let n = t.apps.iter().filter(|a| a.kind == kind).count();
        gauge("apps", &format!("kind=\"{kind}\""), n as f64);
    }
    if let Some(u) = &t.updates {
        gauge("os_updates_pending", "", u.pending.len() as f64);
        if let Some(r) = u.reboot_pending {
            gauge("os_reboot_pending", "", if r { 1.0 } else { 0.0 });
        }
    }
    for d in &t.drives {
        let l = format!("drive=\"{}\"", esc(&d.name));
        if let Some(v) = d.temperature_c {
            gauge("drive_temperature_celsius", &l, v);
        }
        if let Some(v) = d.power_on_hours {
            gauge("drive_power_on_hours", &l, v as f64);
        }
        if let Some(v) = d.wear_pct {
            gauge("drive_wear_percent", &l, v);
        }
        if let Some(h) = &d.health {
            gauge(
                "drive_healthy",
                &l,
                if matches!(h.as_str(), "healthy" | "verified") {
                    1.0
                } else {
                    0.0
                },
            );
        }
    }
    for d in &t.disks {
        let l = format!("mount=\"{}\"", esc(&d.mount));
        for (k, v) in [
            ("disk_total_bytes", d.total_bytes),
            ("disk_used_bytes", d.used_bytes),
            ("disk_free_bytes", d.free_bytes),
        ] {
            if let Some(v) = v {
                gauge(k, &l, v as f64);
            }
        }
    }
    for (i, g) in t.gpus.iter().enumerate() {
        let l = format!("gpu=\"{i}\",name=\"{}\"", esc(&g.name));
        if let Some(v) = g.usage_pct {
            gauge("gpu_usage_percent", &l, v);
        }
        if let Some(v) = g.temperature_c {
            gauge("gpu_temperature_celsius", &l, v);
        }
        if let Some(v) = g.power_w {
            gauge("gpu_power_watts", &l, v);
        }
        if let Some(v) = g.vram_total_bytes {
            gauge("gpu_vram_total_bytes", &l, v as f64);
        }
        if let Some(v) = g.vram_used_bytes {
            gauge("gpu_vram_used_bytes", &l, v as f64);
        }
    }
    for x in &t.temperatures {
        gauge(
            "temperature_celsius",
            &format!("sensor=\"{}\"", esc(&x.label)),
            x.celsius,
        );
    }
    for n in &t.network {
        let l = format!("interface=\"{}\"", esc(&n.interface));
        if let Some(v) = n.rx_bytes {
            gauge("network_receive_bytes_total", &l, v as f64);
        }
        if let Some(v) = n.tx_bytes {
            gauge("network_transmit_bytes_total", &l, v as f64);
        }
    }
    if let Some(b) = &t.battery {
        if let Some(v) = b.percent {
            gauge("battery_percent", "", v);
        }
        if let Some(v) = b.health_pct {
            gauge("battery_health_percent", "", v);
        }
    }
    out
}

/// One machine's providers, from their last report (providers/):
///
/// - `daedalus_agent_provider_up{…,kind,port,version,offered}`: 1 while the
///   provider answers and calls itself healthy, 0 while it is installed and
///   silent or answers unhealthy. `offered` is "1" when the app offers it to
///   the gateway (`nodes.set_desired`), which is what "Model Server Down"
///   alerts on.
/// - `daedalus_agent_provider_models{…,kind}`: catalog entries on disk.
/// - `daedalus_agent_provider_loaded{…,kind}`: models resident now.
pub fn providers_text(
    list: &[crate::providers::ProviderReport],
    offered: impl Fn(crate::providers::ProviderKind) -> bool,
    labels: &Labels,
) -> String {
    let base = labels.render();
    let mut out = String::new();
    for p in list {
        let kind = escape_label(&p.kind.to_string());
        out.push_str(&format!(
            "daedalus_agent_provider_up{{{base},kind=\"{kind}\",port=\"{}\",version=\"{}\",offered=\"{}\"}} {}\n",
            p.port,
            escape_label(p.version.as_deref().unwrap_or("")),
            u8::from(offered(p.kind)),
            u8::from(p.running && p.healthy)
        ));
        out.push_str(&format!(
            "daedalus_agent_provider_models{{{base},kind=\"{kind}\"}} {}\n",
            p.models.iter().filter(|m| m.downloaded).count()
        ));
        out.push_str(&format!(
            "daedalus_agent_provider_loaded{{{base},kind=\"{kind}\"}} {}\n",
            p.loaded.len()
        ));
    }
    out
}

/// One machine's Claude remote control, from its session's last report —
/// the same series for every machine and for the controller itself, so one
/// alert covers them all:
///
/// - `daedalus_agent_claude_up{…,state="<state>"}`: 1 while the server is
///   `running`, 0 otherwise; the state is the report's (`off`, `waiting`,
///   `not-installed`…), or `none` when no session reports. An alert on
///   `== 0` wants `state!="off"` beside it: off is the policy's word.
/// - `daedalus_agent_claude_restarts_total`: starts after the first, since
///   the session came up (it resets when the session does).
/// - `daedalus_agent_claude_sessions`: sessions alive under it.
pub fn claude_text(report: Option<&crate::claude::Report>, labels: &Labels) -> String {
    let base = labels.render();
    let state = report.map_or_else(|| "none".to_string(), |r| r.state.to_string());
    let mut out = format!(
        "daedalus_agent_claude_up{{{base},state=\"{}\"}} {}\n",
        escape_label(&state),
        u8::from(report.is_some_and(|r| r.state == crate::claude::ClaudeState::Running))
    );
    if let Some(r) = report {
        out.push_str(&format!(
            "daedalus_agent_claude_restarts_total{{{base}}} {}\n",
            r.restarts
        ));
        out.push_str(&format!(
            "daedalus_agent_claude_sessions{{{base}}} {}\n",
            r.sessions.iter().filter(|s| s.alive).count()
        ));
    }
    out
}

/// The page's series as the exposition format wants them: each family's
/// lines together under one `# TYPE` — `counter` for a `_total` name (the
/// OS's byte counts, Claude's restarts), `gauge` for every other. The
/// writers above emit one machine at a time; this runs once over the page,
/// so a family every machine reports is typed once, not once per machine.
pub fn typed(text: &str) -> String {
    let mut families: Vec<(&str, Vec<&str>)> = Vec::new();
    for line in text
        .lines()
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
    {
        let name = line.split(['{', ' ']).next().unwrap_or(line);
        match families.iter_mut().find(|(n, _)| *n == name) {
            Some((_, lines)) => lines.push(line),
            None => families.push((name, vec![line])),
        }
    }
    let mut out = String::with_capacity(text.len() + 48 * families.len());
    for (name, lines) in families {
        let kind = if name.ends_with("_total") {
            "counter"
        } else {
            "gauge"
        };
        out.push_str(&format!("# TYPE {name} {kind}\n"));
        for l in lines {
            out.push_str(l);
            out.push('\n');
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::{Cpu, Disk};

    const PC: Labels<'static> = Labels {
        node: "0123456789abcdef",
        host: "PC",
        machine: "Gaming PC",
        os: "windows",
    };
    const BASE: &str = "host=\"PC\",machine=\"Gaming PC\",node=\"0123456789abcdef\",os=\"windows\"";

    /// Two machines' text, typed: each family once, its lines together.
    #[test]
    fn the_page_types_each_family_once() {
        let two = "a_up{node=\"1\"} 1\nb_bytes_total{node=\"1\"} 5\na_up{node=\"2\"} 0\nb_bytes_total{node=\"2\"} 7\n";
        assert_eq!(
            typed(two),
            "# TYPE a_up gauge\na_up{node=\"1\"} 1\na_up{node=\"2\"} 0\n\
             # TYPE b_bytes_total counter\nb_bytes_total{node=\"1\"} 5\nb_bytes_total{node=\"2\"} 7\n"
        );
        assert_eq!(typed(""), "");
    }

    #[test]
    fn metrics_render_with_labels_escaped() {
        let t = Telemetry {
            cpu: Cpu {
                model: Some("A \"B\"".into()),
                usage_pct: Some(3.0),
                ..Default::default()
            },
            disks: vec![Disk {
                mount: "C:".into(),
                total_bytes: Some(10),
                ..Default::default()
            }],
            ..Default::default()
        };
        let m = metrics_text(&t, "0.7.0", &PC);
        assert!(m.contains(&format!("daedalus_agent_cpu_usage_percent{{{BASE}}} 3\n")));
        assert!(m.contains(&format!(
            "daedalus_agent_disk_total_bytes{{{BASE},mount=\"C:\"}} 10\n"
        )));
        assert!(m.contains("cpu=\"A \\\"B\\\"\""));
        assert!(m.contains(&format!("daedalus_agent_apps{{{BASE},kind=\"game\"}} 0\n")));
        // Every series carries the four labels.
        for line in m.lines() {
            assert!(line.contains(&format!("{{{BASE}")), "{line}");
        }
    }

    #[test]
    fn claude_series_carry_the_state_and_the_four_labels() {
        use crate::claude::{Report, Session};
        let r = Report {
            state: crate::claude::ClaudeState::Running,
            restarts: 3,
            sessions: vec![
                Session {
                    alive: true,
                    ..Default::default()
                },
                Session::default(),
            ],
            ..Default::default()
        };
        assert_eq!(
            claude_text(Some(&r), &PC),
            format!(
                "daedalus_agent_claude_up{{{BASE},state=\"running\"}} 1\n\
                 daedalus_agent_claude_restarts_total{{{BASE}}} 3\n\
                 daedalus_agent_claude_sessions{{{BASE}}} 1\n"
            )
        );
        let off = Report {
            state: crate::claude::ClaudeState::Off,
            ..Default::default()
        };
        assert!(claude_text(Some(&off), &PC).starts_with(&format!(
            "daedalus_agent_claude_up{{{BASE},state=\"off\"}} 0\n"
        )));
        assert_eq!(
            claude_text(None, &PC),
            format!("daedalus_agent_claude_up{{{BASE},state=\"none\"}} 0\n")
        );
    }

    #[test]
    fn labels_cannot_break_or_forge_a_line() {
        assert_eq!(escape_label("a\\b\"c"), "a\\\\b\\\"c");
        assert_eq!(escape_label("x\ny"), "x\\ny");
        assert_eq!(escape_label("x\r\t\u{7}\u{1b}[31my"), "x[31my");
        assert_eq!(escape_label("Santiago’s MacBook"), "Santiago’s MacBook");
        // A hostname or name that tries to add a series stays inside its label.
        let evil = "PC\"} 1\ndaedalus_agent_fake{host=\"x";
        let labels = Labels {
            host: evil,
            machine: evil,
            ..PC
        };
        let m = metrics_text(&Telemetry::default(), "1", &labels);
        for line in m.lines() {
            assert!(line.starts_with("daedalus_agent_"), "{line}");
            assert!(!line.starts_with("daedalus_agent_fake"), "{line}");
        }
        assert!(m.contains("host=\"PC\\\"} 1\\ndaedalus_agent_fake{host=\\\"x\",machine="));
    }
}
