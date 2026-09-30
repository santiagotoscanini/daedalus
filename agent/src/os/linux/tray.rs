//! The tray's Linux side: one instance per user (a file lock), GTK's main
//! loop driving `tray::Tray` four times a second, `xdg-open` as the opener,
//! and leaving for a new binary by starting it first — XDG autostart fires
//! once per login, so nothing else would.
//!
//! The tray is a UI over the session unit (`os::TRAY_OWNS_SESSION` is
//! false), so everything here is optional to the machine: without a
//! graphical session, or without an AppIndicator library for the icon, it
//! says so in one line and exits, and Claude remote control carries on in
//! the session unit. (GTK itself is linked; a machine without it stops the
//! binary at load, with the loader's own one-line message.)

use std::cell::RefCell;
use std::time::Duration;

use anyhow::{bail, Context, Result};

use crate::paths;
use crate::tray::{Flow, Tray};

/// The libraries tray-icon loads at run time for the icon, Ayatana's first.
const APPINDICATOR: &[&str] = &[
    "libayatana-appindicator3.so.1",
    "libappindicator3.so.1",
    "libayatana-appindicator3.so",
    "libappindicator3.so",
];

/// One tray per user: a lock on a file in the user's log directory, held
/// for the life of the process (the file is leaked on purpose). Waited for
/// up to ten seconds, as on Windows: a tray relaunching itself for an
/// update starts while the old one is still leaving.
fn claim_single_instance() -> bool {
    let dir = paths::user_log_dir();
    let _ = std::fs::create_dir_all(&dir);
    let path = dir.join("tray.lock");
    let until = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        if let Some(f) = super::super::unix::lock_exclusive(&path) {
            std::mem::forget(f);
            return true;
        }
        if std::time::Instant::now() > until {
            return false;
        }
        std::thread::sleep(Duration::from_millis(250));
    }
}

/// Whether any AppIndicator library loads, asked before tray-icon would
/// panic on its absence.
fn appindicator_present() -> bool {
    APPINDICATOR.iter().any(|name| {
        let Ok(c) = std::ffi::CString::new(*name) else {
            return false;
        };
        // SAFETY: dlopen with a valid name; the handle is closed at once.
        unsafe {
            let h = libc::dlopen(c.as_ptr(), libc::RTLD_LAZY);
            if h.is_null() {
                false
            } else {
                libc::dlclose(h);
                true
            }
        }
    })
}

/// `xdg-open` hands a URL to the default browser and a folder to the file
/// manager.
pub fn open(target: &str) {
    let _ = std::process::Command::new("xdg-open").arg(target).spawn();
}

/// Start this same program again from its path, before leaving: the file
/// under our feet is a newer one by then.
pub fn relaunch_self() {
    if let Ok(exe) = std::env::current_exe() {
        let mut cmd = std::process::Command::new(exe);
        super::super::unix::own_process_group(&mut cmd);
        let _ = cmd.spawn();
    }
}

pub fn run() -> Result<()> {
    let r = run_gtk();
    if let Err(e) = &r {
        // Autostart shows no window; a terminal, or the session's journal,
        // gets the reason in one line. main() also writes it to tray.err.
        eprintln!("daedalus-agent-tray: {e:#}");
    }
    r
}

fn run_gtk() -> Result<()> {
    let display = ["DISPLAY", "WAYLAND_DISPLAY"]
        .iter()
        .any(|v| std::env::var_os(v).is_some_and(|x| !x.is_empty()));
    if !display {
        bail!("no graphical session (neither DISPLAY nor WAYLAND_DISPLAY is set); the session unit runs Claude remote control without the tray");
    }
    if !appindicator_present() {
        bail!("no AppIndicator library (install libayatana-appindicator3); the session unit runs Claude remote control without the tray");
    }
    if !claim_single_instance() {
        return Ok(());
    }
    gtk::init().context("GTK did not start")?;
    let tray = RefCell::new(Some(Tray::start()?));
    gtk::glib::timeout_add_local(Duration::from_millis(250), move || {
        let mut slot = tray.borrow_mut();
        let Some(t) = slot.as_mut() else {
            return gtk::glib::ControlFlow::Break;
        };
        if t.menu() == Flow::Quit || t.tick() == Flow::Quit {
            // The tray (and its icon) goes before the loop ends.
            slot.take();
            gtk::main_quit();
            return gtk::glib::ControlFlow::Break;
        }
        gtk::glib::ControlFlow::Continue
    });
    gtk::main();
    Ok(())
}

/// "Pair with the box…": a GTK dialog with one text field — GTK is linked
/// and its loop is the tray's, so no other program is needed. Not modal:
/// its answer comes through `connect_response` on the loop the tray already
/// runs, so the tray's tick (which holds the tray while it runs) is never
/// re-entered. `pair` runs elevated through polkit (`pair_elevated`); its
/// answer is a message dialog.
pub fn join() {
    use gtk::prelude::*;
    let dialog = gtk::Dialog::with_buttons(
        Some(crate::tray::PAIR_TITLE),
        None::<&gtk::Window>,
        gtk::DialogFlags::empty(),
        &[
            ("Cancel", gtk::ResponseType::Cancel),
            ("Pair", gtk::ResponseType::Accept),
        ],
    );
    dialog.set_default_response(gtk::ResponseType::Accept);
    dialog.set_keep_above(true);
    let label = gtk::Label::new(Some(crate::tray::PAIR_PROMPT));
    label.set_line_wrap(true);
    label.set_xalign(0.0);
    let entry = gtk::Entry::new();
    entry.set_activates_default(true);
    entry.set_width_chars(64);
    let area = dialog.content_area();
    area.set_spacing(10);
    area.set_border_width(12);
    area.add(&label);
    area.add(&entry);
    dialog.connect_response(move |d, response| {
        if response == gtk::ResponseType::Accept {
            // The prompt (polkit's) and `pair` take as long as the person
            // does: a thread of their own, the answer back on the loop.
            let text = entry.text().to_string();
            let spawned = std::thread::Builder::new()
                .name("pair".into())
                .spawn(move || {
                    let said = crate::tray::pair_pasted(&text);
                    gtk::glib::MainContext::default().invoke(move || tell(said));
                });
            if let Err(e) = spawned {
                tell(Err(format!("could not start pairing: {e}")));
            }
        }
        // SAFETY: the dialog is ours; this is its last use.
        unsafe { d.destroy() };
    });
    dialog.show_all();
}

/// The pairing's outcome, as a message dialog on the tray's loop.
fn tell(said: Result<String, String>) {
    use gtk::prelude::*;
    let (kind, said) = match said {
        Ok(said) => (gtk::MessageType::Info, said),
        Err(e) => (gtk::MessageType::Warning, format!("Not paired: {e}")),
    };
    let answer = gtk::MessageDialog::new(
        None::<&gtk::Window>,
        gtk::DialogFlags::empty(),
        kind,
        gtk::ButtonsType::Ok,
        &said,
    );
    answer.set_title(crate::tray::PAIR_TITLE);
    answer.set_keep_above(true);
    // SAFETY: the dialog is ours and nothing else holds it.
    answer.connect_response(|m, _| unsafe { m.destroy() });
    answer.show_all();
}

/// Run `pair` as root through polkit's `pkexec`, which asks for an
/// administrator in the desktop's own prompt (tray.rs `pkexec_argv`).
/// Without pkexec, or when polkit could not ask, the answer is the exact
/// `sudo` line to type instead.
pub fn pair_elevated(
    exe: &std::path::Path,
    args: &[String],
    p: &crate::pair::Pairing,
) -> Result<String, String> {
    let by_hand = || {
        format!(
            "In a terminal:\n  {}",
            crate::pair::command_line(&p.pin, p.controller.as_deref())
        )
    };
    let Some(pkexec) = find_pkexec() else {
        return Err(format!(
            "this desktop has no pkexec to ask for an administrator. {}",
            by_hand()
        ));
    };
    let argv = crate::tray::pkexec_argv(&pkexec, exe, args);
    let out = std::process::Command::new(&argv[0])
        .args(&argv[1..])
        .stdin(std::process::Stdio::null())
        .output()
        .map_err(|e| format!("could not start pkexec: {e}. {}", by_hand()))?;
    match out.status.code() {
        Some(0) => {
            let said = String::from_utf8_lossy(&out.stdout).trim().to_string();
            Ok(if said.is_empty() {
                format!("paired: this machine trusts {}", p.pin)
            } else {
                said
            })
        }
        // pkexec's own: dismissed or not authorised (126), or no agent to
        // ask with (127).
        Some(126) => Err(format!(
            "the administrator prompt was dismissed. {}",
            by_hand()
        )),
        Some(127) => Err(format!(
            "polkit could not ask for an administrator here. {}",
            by_hand()
        )),
        _ => Err(format!(
            "{}\n{}",
            String::from_utf8_lossy(&out.stderr).trim(),
            by_hand()
        )),
    }
}

/// pkexec where a setuid copy is found: NixOS's wrapper first, then PATH,
/// then the usual place.
fn find_pkexec() -> Option<std::path::PathBuf> {
    let path = std::env::var_os("PATH").unwrap_or_default();
    std::iter::once(std::path::PathBuf::from("/run/wrappers/bin"))
        .chain(std::env::split_paths(&path))
        .chain([std::path::PathBuf::from("/usr/bin")])
        .map(|d| d.join("pkexec"))
        .find(|p| p.is_file())
}
