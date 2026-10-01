//! The projects tree: every transcript file under it, the newest scanned
//! (each scan kept by size and mtime), and the one resume names.

use std::collections::HashMap;
use std::path::Path;

use super::transcript::{read_prefix, regular_file, scan, Head};
use super::{
    cut, is_uuid, unslug, Meta, Transcript, HEAD_BYTES, MAX_FILES, MAX_TRANSCRIPTS, SIDECAR_BYTES,
};
use crate::time::epoch_ms;

struct FileStat {
    id: String,
    project: String,
    size: u64,
    mtime_ms: u64,
}

pub(super) fn mtime_ms(m: &std::fs::Metadata) -> u64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs() * 1000)
        .unwrap_or(0)
}

/// Every `<uuid>.jsonl` regular file in a real directory under `projects`.
fn list(projects: &Path, errors: &mut Vec<String>) -> Vec<FileStat> {
    let mut out = Vec::new();
    let Ok(dirs) = std::fs::read_dir(projects) else {
        return out;
    };
    let mut seen = 0usize;
    for d in dirs.flatten() {
        // `file_type` does not follow a link: a linked project is skipped.
        if !d.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        let project = d.file_name().to_string_lossy().into_owned();
        let Ok(files) = std::fs::read_dir(d.path()) else {
            continue;
        };
        for f in files.flatten() {
            seen += 1;
            if seen > MAX_FILES {
                errors.push(format!(
                    "more than {MAX_FILES} files under the projects tree; the rest were not read"
                ));
                return out;
            }
            let name = f.file_name().to_string_lossy().into_owned();
            let Some(id) = name.strip_suffix(".jsonl").filter(|i| is_uuid(i)) else {
                continue;
            };
            if !f.file_type().is_ok_and(|t| t.is_file()) {
                continue;
            }
            let Ok(m) = f.metadata() else { continue };
            out.push(FileStat {
                id: id.to_string(),
                project: project.clone(),
                size: m.len(),
                mtime_ms: mtime_ms(&m),
            });
        }
    }
    out
}

/// The transcripts, with every scan kept between calls by (size, mtime),
/// so a warm read rescans only the files that moved.
#[derive(Default)]
pub struct Scanner {
    cache: HashMap<String, (u64, u64, Meta)>,
}

/// What `Scanner::transcripts` found.
pub struct Found {
    pub transcripts: Vec<Transcript>,
    pub total: usize,
    pub empty: usize,
}

impl Scanner {
    /// The newest `MAX_TRANSCRIPTS` non-empty transcripts under `projects`.
    pub fn transcripts(&mut self, projects: &Path, errors: &mut Vec<String>) -> Found {
        let mut files = list(projects, errors);
        let empty = files.iter().filter(|f| f.size == 0).count();
        files.retain(|f| f.size > 0);
        let total = files.len();
        files.sort_by(|a, b| b.mtime_ms.cmp(&a.mtime_ms).then(a.id.cmp(&b.id)));
        files.truncate(MAX_TRANSCRIPTS);
        let mut keep = HashMap::new();
        let transcripts = files
            .into_iter()
            .map(|f| {
                let dir = projects.join(&f.project);
                let path = dir.join(format!("{}.jsonl", f.id));
                let meta = match self.cache.remove(&f.id) {
                    Some((size, at, m)) if size == f.size && at == f.mtime_ms => Some(m),
                    _ => std::fs::File::open(&path).ok().map(scan),
                };
                if let Some(m) = &meta {
                    keep.insert(f.id.clone(), (f.size, f.mtime_ms, m.clone()));
                }
                let mut head = Head::default();
                if let Some(p) = read_prefix(&path, HEAD_BYTES) {
                    head.note_text(&p);
                }
                let sidecar = dir.join(&f.id).join("custom-title.json");
                if regular_file(&sidecar) {
                    if let Some(p) = read_prefix(&sidecar, SIDECAR_BYTES) {
                        head.note_text(&p);
                    }
                }
                let (title, title_source) = head.title();
                Transcript {
                    cwd: head
                        .cwd
                        .as_deref()
                        .map(cut)
                        .unwrap_or_else(|| unslug(&f.project)),
                    cwd_exact: head.cwd.is_some(),
                    title,
                    title_source: title_source.map(str::to_string),
                    started_at: head.started_at.as_deref().and_then(epoch_ms),
                    modified_at: f.mtime_ms,
                    size_bytes: f.size,
                    meta,
                    id: f.id,
                    project: f.project,
                }
            })
            .collect();
        // What left the listing leaves the cache.
        self.cache = keep;
        Found {
            transcripts,
            total,
            empty,
        }
    }
}

/// The project directory holding `<id>.jsonl` as a regular file, by name
/// (resume's existential check, sessions/).
pub fn find_transcript(projects: &Path, id: &str) -> Option<String> {
    let dirs = std::fs::read_dir(projects).ok()?;
    for d in dirs.flatten() {
        if !d.file_type().is_ok_and(|t| t.is_dir()) {
            continue;
        }
        if regular_file(&d.path().join(format!("{id}.jsonl"))) {
            return Some(d.file_name().to_string_lossy().into_owned());
        }
    }
    None
}
