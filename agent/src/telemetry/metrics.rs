//! `/metrics`: the telemetry document as Prometheus text, for the box to
//! scrape.

use super::Telemetry;

/// Prometheus text exposition of the document. Gauges only; the counters
/// the OS keeps (network bytes) are exposed as counters.
pub fn metrics_text(t: &Telemetry, agent_version: &str, hostname: &str) -> String {
    let mut out = String::new();
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let host = esc(hostname);
    let mut gauge = |name: &str, labels: &str, v: f64| {
        let sep = if labels.is_empty() { "" } else { "," };
        out.push_str(&format!(
            "daedalus_agent_{name}{{host=\"{host}\"{sep}{labels}}} {v}\n"
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
    // A provider found on the machine: 1 when it answers, 0 when it is
    // installed and silent. The version rides as a label, like the agent's.
    for p in &t.providers {
        gauge(
            "provider_up",
            &format!(
                "kind=\"{}\",port=\"{}\",version=\"{}\"",
                esc(&p.kind),
                p.port,
                esc(p.version.as_deref().unwrap_or(""))
            ),
            if p.running { 1.0 } else { 0.0 },
        );
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::telemetry::{Cpu, Disk};

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
        let m = metrics_text(&t, "0.7.0", "PC");
        assert!(m.contains("daedalus_agent_cpu_usage_percent{host=\"PC\"} 3\n"));
        assert!(m.contains("daedalus_agent_disk_total_bytes{host=\"PC\",mount=\"C:\"} 10\n"));
        assert!(m.contains("cpu=\"A \\\"B\\\"\""));
        assert!(m.contains("daedalus_agent_apps{host=\"PC\",kind=\"game\"} 0\n"));
    }
}
