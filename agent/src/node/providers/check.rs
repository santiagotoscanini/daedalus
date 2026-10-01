//! What the controller holds a pushed `providers` document to (`check`),
//! and what the link compares to push only what moved (`digest`).

use serde_json::Value;

use super::*;

/// The document without its clocks: what the link compares to push only
/// what moved.
pub fn digest(list: &[ProviderReport]) -> String {
    let mut v = serde_json::to_value(list).unwrap_or(Value::Null);
    if let Some(a) = v.as_array_mut() {
        for p in a.iter_mut().filter_map(Value::as_object_mut) {
            p.remove("read_at");
        }
    }
    v.to_string()
}

/// The bounds the controller holds a pushed document to.
pub fn check(list: &[ProviderReport]) -> Result<(), String> {
    fn text(what: &str, s: &str, max: usize) -> Result<(), String> {
        if s.len() > max || s.chars().any(char::is_control) {
            return Err(format!(
                "{what} is longer than {max} bytes or has control characters"
            ));
        }
        Ok(())
    }
    fn opt(what: &str, s: &Option<String>, max: usize) -> Result<(), String> {
        s.as_deref().map_or(Ok(()), |s| text(what, s, max))
    }
    if list.len() > MAX_PROVIDERS {
        return Err(format!("more than {MAX_PROVIDERS} providers"));
    }
    for p in list {
        opt("version", &p.version, MAX_WORD)?;
        // Every read is stamped: an entry without the stamp is not a read, and
        // keeping it would be a provider answering with an empty catalog.
        if p.read_at.is_empty() {
            return Err(format!("{}: not a read (no read_at)", p.kind));
        }
        text("read_at", &p.read_at, MAX_WORD)?;
        opt("error", &p.error, MAX_TEXT)?;
        if p.loaded.len() > MAX_LOADED
            || p.models.len() > MAX_MODELS
            || p.downloads.len() > MAX_DOWNLOADS
            || p.backends.len() > MAX_BACKENDS
            || p.figures.len() > MAX_MODELS
        {
            return Err(format!("{}: a list past its bound", p.kind));
        }
        for m in &p.loaded {
            text("loaded.id", &m.id, MAX_TEXT)?;
            opt("loaded.device", &m.device, MAX_WORD)?;
        }
        for m in &p.models {
            text("models.id", &m.id, MAX_TEXT)?;
            opt("models.recipe", &m.recipe, MAX_WORD)?;
            if m.labels.len() > MAX_LABELS {
                return Err(format!("{}: more than {MAX_LABELS} labels", m.id));
            }
            for l in &m.labels {
                text("a label", l, MAX_WORD)?;
            }
        }
        for d in &p.downloads {
            text("downloads.model", &d.model, MAX_TEXT)?;
            text("downloads.status", &d.status, MAX_WORD)?;
        }
        for b in &p.backends {
            text("backends.recipe", &b.recipe, MAX_WORD)?;
            text("backends.backend", &b.backend, MAX_WORD)?;
            opt("backends.version", &b.version, MAX_WORD)?;
            opt("backends.url", &b.url, MAX_TEXT)?;
        }
        for f in &p.figures {
            text("figures.model", &f.model, MAX_TEXT)?;
            opt("figures.device", &f.device, MAX_WORD)?;
            opt("figures.checkpoint", &f.checkpoint, MAX_TEXT)?;
        }
        if p.actions.len() > MAX_ACTIONS {
            return Err(format!("{}: more than {MAX_ACTIONS} actions", p.kind));
        }
        for a in &p.actions {
            text("actions.request", &a.request, MAX_WORD)?;
            text("actions.model", &a.model, MAX_TEXT)?;
            text("actions.message", &a.message, MAX_TEXT)?;
            text("actions.at", &a.at, MAX_WORD)?;
        }
    }
    Ok(())
}
