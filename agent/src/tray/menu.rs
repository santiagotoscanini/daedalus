//! The menu itself: built once (`Ui::build`), redrawn in place from the
//! rows model.rs makes (`Ui::show`).

use anyhow::{Context, Result};
#[cfg(not(target_os = "macos"))]
use tray_icon::menu::CheckMenuItem;
use tray_icon::menu::{IconMenuItem, IsMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tray_icon::{Icon, TrayIcon, TrayIconBuilder};

use super::app_url;
use super::model::*;
use crate::claude::Report;
use crate::core::status::StatusDocument;
use crate::node::settings::{Key, View};
use crate::{DISPLAY_NAME, VERSION};

/// What quitting does: the tray alone (module doc).
#[cfg(target_os = "macos")]
pub(super) const QUIT_LABEL: &str = "Quit menu bar app";
#[cfg(not(target_os = "macos"))]
pub(super) const QUIT_LABEL: &str = "Quit tray icon";

pub(super) const ICON_OK: &[u8] = include_bytes!("../../assets/tray-ok.png");
pub(super) const ICON_WARN: &[u8] = include_bytes!("../../assets/tray-warn.png");
pub(super) const ICON_OFF: &[u8] = include_bytes!("../../assets/tray-off.png");

#[derive(PartialEq, Eq, Clone, Copy)]
pub(super) enum Look {
    Ok,
    Warn,
    Off,
}

pub(super) struct Icons {
    pub(super) ok: Icon,
    pub(super) warn: Icon,
    pub(super) off: Icon,
}

pub(super) fn decode(png: &[u8]) -> Result<Icon> {
    let mut decoder = png::Decoder::new(std::io::Cursor::new(png));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().context("png header")?;
    let mut buf = vec![0u8; reader.output_buffer_size().unwrap_or(0)];
    let info = reader.next_frame(&mut buf).context("png frame")?;
    let rgba = match info.color_type {
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => buf[..info.buffer_size()]
            .chunks(3)
            .flat_map(|p| [p[0], p[1], p[2], 255])
            .collect(),
        other => anyhow::bail!("tray icon is {other:?}, not RGB(A)"),
    };
    Icon::from_rgba(rgba, info.width, info.height).context("tray icon pixels")
}

// ── the menu itself ──────────────────────────────────────────────────────

/// The menu's glyphs (macOS): Lucide icons by name, each a template image in
/// the bundle's Resources as `<name>Template.png` and `@2x` (macos/icons/).
/// Outside a bundle (a development build) AppKit finds none, and the rows
/// have no icon.
#[cfg(any(test, target_os = "macos"))]
pub const ICONS: [&str; 11] = [
    "check",
    "layout-dashboard",
    "settings",
    "network",
    "sparkles",
    "trees",
    "refresh-cw",
    "life-buoy",
    "user",
    "trash-2",
    "power",
];

#[cfg(target_os = "macos")]
pub(super) fn glyph(name: &str) -> tray_icon::menu::NativeIcon {
    debug_assert!(ICONS.contains(&name));
    tray_icon::menu::NativeIcon::from_name(format!("{name}Template"))
}

/// A grey status dot for the header (AppKit has green, amber and red; its
/// "none" is clear), the size of theirs: 36 px for muda's 18 points.
#[cfg(target_os = "macos")]
pub(super) fn grey_dot() -> Result<tray_icon::menu::Icon> {
    const SIZE: u32 = 36;
    let (c, r) = (SIZE as f32 / 2.0, 7.0_f32);
    let mut rgba = Vec::with_capacity((SIZE * SIZE * 4) as usize);
    for y in 0..SIZE {
        for x in 0..SIZE {
            let d = ((x as f32 + 0.5 - c).powi(2) + (y as f32 + 0.5 - c).powi(2)).sqrt();
            let a = (r + 0.5 - d).clamp(0.0, 1.0);
            rgba.extend_from_slice(&[142, 142, 147, (a * 255.0) as u8]);
        }
    }
    tray_icon::menu::Icon::from_rgba(rgba, SIZE, SIZE).context("the grey dot")
}

/// A switch's row. On a Mac it is an image row like every other, whose
/// image is its `Mark` — AppKit's own state column would put the check in
/// a gutter left of every other row's glyph and the switch's words left of
/// theirs. Elsewhere no row has a glyph, so the OS's check column is the
/// leading column.
#[cfg(target_os = "macos")]
pub(super) type Toggle = IconMenuItem;
#[cfg(not(target_os = "macos"))]
pub(super) type Toggle = CheckMenuItem;

/// An empty image the size of a glyph: an unchecked switch's mark (a Mac).
#[cfg(target_os = "macos")]
pub(super) fn blank() -> Result<tray_icon::menu::Icon> {
    const SIZE: u32 = 36;
    let rgba = vec![0u8; (SIZE * SIZE * 4) as usize];
    tray_icon::menu::Icon::from_rgba(rgba, SIZE, SIZE).context("the blank mark")
}

/// A value's submenu: the whole value (a disabled row) and Copy, where the
/// OS has a clipboard to reach (not Linux).
pub(super) struct Copyable {
    pub(super) menu: Submenu,
    pub(super) full: MenuItem,
    #[cfg(any(target_os = "macos", windows))]
    pub(super) copy: MenuItem,
    pub(super) value: String,
}

impl Copyable {
    fn new() -> Result<Self> {
        let menu = Submenu::new("…", true);
        let full = MenuItem::new("—", false, None);
        menu.append(&full).context("building the menu")?;
        #[cfg(any(target_os = "macos", windows))]
        let copy = MenuItem::new("Copy", true, None);
        #[cfg(any(target_os = "macos", windows))]
        menu.append(&copy).context("building the menu")?;
        Ok(Self {
            menu,
            full,
            #[cfg(any(target_os = "macos", windows))]
            copy,
            value: String::new(),
        })
    }

    pub(super) fn show(&mut self, (row, full): &(String, String)) {
        self.menu.set_text(row);
        self.full.set_text(full);
        let known = full != "—";
        #[cfg(any(target_os = "macos", windows))]
        self.copy.set_enabled(known);
        self.value = if known { full.clone() } else { String::new() };
    }
}

pub(super) struct Ui {
    pub(super) tray: TrayIcon,
    pub(super) icons: Icons,
    pub(super) look: Look,
    pub(super) header: IconMenuItem,
    pub(super) header_now: Option<Header>,
    #[cfg(target_os = "macos")]
    pub(super) grey: tray_icon::menu::Icon,
    pub(super) open_app: IconMenuItem,
    pub(super) this_machine: IconMenuItem,
    pub(super) awake: Toggle,
    pub(super) claude_rc: Toggle,
    #[cfg(unix)]
    pub(super) santree: Toggle,
    #[cfg(target_os = "macos")]
    pub(super) blank: tray_icon::menu::Icon,
    /// Each switch's mark as last drawn, by `Key`: an image is set only
    /// when it changes.
    #[cfg(target_os = "macos")]
    pub(super) marks: [Option<Mark>; 3],
    /// The row under the switches, in the menu only while it has something
    /// to say (`switches_note`), at `note_at`.
    pub(super) note: MenuItem,
    pub(super) note_shown: bool,
    pub(super) note_at: usize,
    pub(super) menu: Menu,
    pub(super) connection: Submenu,
    pub(super) link: MenuItem,
    pub(super) vpn: MenuItem,
    pub(super) traffic: MenuItem,
    pub(super) address: MenuItem,
    pub(super) endpoint: MenuItem,
    pub(super) own_key: Copyable,
    pub(super) box_key: Copyable,
    pub(super) claude: Submenu,
    pub(super) claude_server: MenuItem,
    pub(super) claude_folder: MenuItem,
    pub(super) update_claude: MenuItem,
    pub(super) restart_claude: MenuItem,
    pub(super) open_claude_log: MenuItem,
    #[cfg(unix)]
    pub(super) santree_menu: Submenu,
    #[cfg(unix)]
    pub(super) santree_host: MenuItem,
    #[cfg(unix)]
    pub(super) santree_open: MenuItem,
    #[cfg(unix)]
    pub(super) santree_refused: MenuItem,
    pub(super) updates: Submenu,
    pub(super) check_now: MenuItem,
    pub(super) open_status: MenuItem,
    pub(super) open_logs: MenuItem,
    /// Log in / log out (a Mac), pair (elsewhere): one row whose words swap.
    pub(super) account: IconMenuItem,
    #[cfg(target_os = "macos")]
    pub(super) uninstall: IconMenuItem,
    pub(super) quit: IconMenuItem,
    /// The settings as last read, for a click's next value.
    pub(super) settings: Option<View>,
    /// Whether the account row logs out (a Mac logged in) rather than in.
    #[cfg(target_os = "macos")]
    pub(super) logged_in: bool,
    /// When Login Items was last asked: at most once a minute, and only while
    /// the service does not answer.
    #[cfg(target_os = "macos")]
    pub(super) login_asked: Option<std::time::Instant>,
    #[cfg(target_os = "macos")]
    pub(super) switched_off: bool,
}

impl Ui {
    pub(super) fn build() -> Result<Self> {
        let icons = Icons {
            ok: decode(ICON_OK)?,
            warn: decode(ICON_WARN)?,
            off: decode(ICON_OFF)?,
        };
        let item = |text: &str, enabled: bool| IconMenuItem::new(text, enabled, None, None);
        let line = |text: &str| MenuItem::new(text, false, None);
        let header = item("…", true);
        let about = line(&format!("{DISPLAY_NAME} {VERSION}"));
        let open_app = item("Open Daedalus", true);
        #[cfg(target_os = "macos")]
        let this_machine = IconMenuItem::new(
            "This Mac in Daedalus…",
            true,
            None,
            Some(cmd(tray_icon::menu::accelerator::Code::Comma)),
        );
        #[cfg(not(target_os = "macos"))]
        let this_machine = item("This machine in Daedalus…", true);
        #[cfg(target_os = "macos")]
        let check = |key: Key| IconMenuItem::new(key.label(), false, None, None);
        #[cfg(not(target_os = "macos"))]
        let check = |key: Key| CheckMenuItem::new(key.label(), false, false, None);
        let awake = check(Key::AwakeHold);
        let claude_rc = check(Key::ClaudeRemoteControl);
        #[cfg(unix)]
        let santree = check(Key::Santree);
        let note = line("");

        let connection = Submenu::new("Connection", true);
        let (link, vpn, traffic, address, endpoint) = (
            line("Box: …"),
            line("VPN: …"),
            line("Traffic: …"),
            line("Tunnel address: …"),
            line("Endpoint: …"),
        );
        let own_key = Copyable::new()?;
        let box_key = Copyable::new()?;
        connection
            .append_items(&[
                &link,
                &vpn,
                &traffic,
                &address,
                &endpoint,
                &PredefinedMenuItem::separator(),
                &own_key.menu,
                &box_key.menu,
            ])
            .context("building the menu")?;

        let claude = Submenu::new("Claude", true);
        let claude_server = line("Remote control: …");
        let claude_folder = line("Folder: …");
        let update_claude = MenuItem::new("Update Claude Code", true, None);
        let restart_claude = MenuItem::new("Restart remote control", true, None);
        let open_claude_log = MenuItem::new("Open remote-control log", true, None);
        claude
            .append_items(&[
                &claude_server,
                &claude_folder,
                &PredefinedMenuItem::separator(),
                &update_claude,
                &restart_claude,
                &open_claude_log,
            ])
            .context("building the menu")?;

        #[cfg(unix)]
        let santree_menu = Submenu::new("santree", true);
        #[cfg(unix)]
        let (santree_host, santree_open, santree_refused) = (
            line("Session host: …"),
            line("Open connections: …"),
            line("Last refused: …"),
        );
        #[cfg(unix)]
        santree_menu
            .append_items(&[&santree_host, &santree_open, &santree_refused])
            .context("building the menu")?;

        let updates = Submenu::new("Updates: …", true);
        let check_now = MenuItem::new("Check for updates now", true, None);
        updates.append(&check_now).context("building the menu")?;
        let troubleshoot = Submenu::new("Troubleshoot", true);
        let open_status = MenuItem::new("Show status (JSON)", true, None);
        let open_logs = MenuItem::new("Open logs folder", true, None);
        troubleshoot
            .append_items(&[&open_status, &open_logs])
            .context("building the menu")?;

        let account = item(JOIN_LABEL, true);
        #[cfg(target_os = "macos")]
        let uninstall = item(&format!("Uninstall {DISPLAY_NAME}…"), true);
        #[cfg(target_os = "macos")]
        let quit = IconMenuItem::new(
            QUIT_LABEL,
            true,
            None,
            Some(cmd(tray_icon::menu::accelerator::Code::KeyQ)),
        );
        #[cfg(not(target_os = "macos"))]
        let quit = item(QUIT_LABEL, true);

        let sep = PredefinedMenuItem::separator;
        let (s1, s2, s3, s4, s5) = (sep(), sep(), sep(), sep(), sep());
        let mut rows: Vec<&dyn IsMenuItem> = vec![&header, &about, &s1, &open_app, &this_machine];
        rows.extend([&s2 as &dyn IsMenuItem, &awake, &claude_rc]);
        #[cfg(unix)]
        rows.push(&santree);
        // The note joins here when it has something to say (`Ui::show`).
        let note_at = rows.len();
        rows.extend([&s3 as &dyn IsMenuItem, &connection, &claude]);
        #[cfg(unix)]
        rows.push(&santree_menu);
        rows.extend([&updates as &dyn IsMenuItem, &troubleshoot, &s4, &account]);
        #[cfg(target_os = "macos")]
        rows.push(&uninstall);
        rows.extend([&s5 as &dyn IsMenuItem, &quit]);
        let menu = Menu::new();
        menu.append_items(&rows).context("building the menu")?;

        #[cfg(target_os = "macos")]
        {
            open_app.set_native_icon(Some(glyph("layout-dashboard")));
            this_machine.set_native_icon(Some(glyph("settings")));
            connection.set_native_icon(Some(glyph("network")));
            claude.set_native_icon(Some(glyph("sparkles")));
            santree_menu.set_native_icon(Some(glyph("trees")));
            updates.set_native_icon(Some(glyph("refresh-cw")));
            troubleshoot.set_native_icon(Some(glyph("life-buoy")));
            account.set_native_icon(Some(glyph("user")));
            uninstall.set_native_icon(Some(glyph("trash-2")));
            quit.set_native_icon(Some(glyph("power")));
        }

        let tray = TrayIconBuilder::new()
            .with_menu(Box::new(menu.clone()))
            .with_tooltip(format!("{DISPLAY_NAME} {VERSION}"))
            .with_icon(icons.off.clone())
            .build()
            .context("creating the tray icon")?;

        Ok(Self {
            tray,
            icons,
            look: Look::Off,
            header,
            header_now: None,
            #[cfg(target_os = "macos")]
            grey: grey_dot()?,
            open_app,
            this_machine,
            awake,
            claude_rc,
            #[cfg(unix)]
            santree,
            #[cfg(target_os = "macos")]
            blank: blank()?,
            #[cfg(target_os = "macos")]
            marks: [None; 3],
            note,
            note_shown: false,
            note_at,
            menu,
            connection,
            link,
            vpn,
            traffic,
            address,
            endpoint,
            own_key,
            box_key,
            claude,
            claude_server,
            claude_folder,
            update_claude,
            restart_claude,
            open_claude_log,
            #[cfg(unix)]
            santree_menu,
            #[cfg(unix)]
            santree_host,
            #[cfg(unix)]
            santree_open,
            #[cfg(unix)]
            santree_refused,
            updates,
            check_now,
            open_status,
            open_logs,
            account,
            #[cfg(target_os = "macos")]
            uninstall,
            quit,
            settings: None,
            #[cfg(target_os = "macos")]
            logged_in: false,
            #[cfg(target_os = "macos")]
            login_asked: None,
            #[cfg(target_os = "macos")]
            switched_off: false,
        })
    }

    fn set_look(&mut self, look: Look) {
        if look == self.look {
            return;
        }
        let icon = match look {
            Look::Ok => &self.icons.ok,
            Look::Warn => &self.icons.warn,
            Look::Off => &self.icons.off,
        };
        let _ = self.tray.set_icon(Some(icon.clone()));
        self.look = look;
    }

    /// The header's dot and line; the dot only where the OS draws one.
    fn set_header(&mut self, h: Header) {
        if self.header_now.as_ref() == Some(&h) {
            return;
        }
        self.header.set_text(&h.text);
        #[cfg(target_os = "macos")]
        {
            use tray_icon::menu::NativeIcon;
            match h.dot {
                Dot::Green => self
                    .header
                    .set_native_icon(Some(NativeIcon::StatusAvailable)),
                Dot::Amber => self
                    .header
                    .set_native_icon(Some(NativeIcon::StatusPartiallyAvailable)),
                Dot::Red => self
                    .header
                    .set_native_icon(Some(NativeIcon::StatusUnavailable)),
                Dot::Grey => self.header.set_icon(Some(self.grey.clone())),
            }
        }
        self.header_now = Some(h);
    }

    /// Whether Login Items has the service switched off: asked only while
    /// the service does not answer (`silent`), at most once a minute.
    #[cfg(target_os = "macos")]
    fn login_items_off(&mut self, silent: bool) -> bool {
        if !silent {
            self.login_asked = None;
            self.switched_off = false;
            return false;
        }
        let now = std::time::Instant::now();
        let due = self
            .login_asked
            .is_none_or(|t| now.duration_since(t) >= std::time::Duration::from_secs(60));
        if due {
            self.login_asked = Some(now);
            self.switched_off = crate::os::tray::service_switched_off();
        }
        self.switched_off
    }

    /// One switch's row: its words, whether it can be clicked, and its mark
    /// in the leading column (`Mark`).
    fn draw_switch(&mut self, key: Key, sw: &Switch) {
        let item = match key {
            Key::AwakeHold => &self.awake,
            Key::ClaudeRemoteControl => &self.claude_rc,
            #[cfg(unix)]
            Key::Santree => &self.santree,
            #[cfg(not(unix))]
            Key::Santree => return,
        };
        item.set_text(&sw.text);
        item.set_enabled(sw.enabled);
        let m = mark(sw);
        #[cfg(target_os = "macos")]
        {
            let slot = &mut self.marks[key as usize];
            if *slot != Some(m) {
                match m {
                    Mark::Check => item.set_native_icon(Some(glyph("check"))),
                    Mark::Blank => item.set_icon(Some(self.blank.clone())),
                }
                *slot = Some(m);
            }
        }
        #[cfg(not(target_os = "macos"))]
        item.set_checked(m == Mark::Check);
    }

    /// The row under the switches, in the menu only while there is
    /// something to say: inserted at its place, removed when it has gone.
    fn show_note(&mut self, note: Option<String>) {
        match note {
            Some(text) => {
                self.note.set_text(&text);
                if !self.note_shown {
                    self.note_shown = self.menu.insert(&self.note, self.note_at).is_ok();
                }
            }
            None if self.note_shown => {
                self.note_shown = self.menu.remove(&self.note).is_err();
            }
            None => {}
        }
    }

    /// Reflect one read of the page (or its absence) and the supervisor's
    /// state. Every row is set on every read, so the menu is right even
    /// while it is open, and a switch muda flipped on its click shows the
    /// service's value again in the same pass.
    pub(super) fn show(
        &mut self,
        page: Option<&StatusDocument>,
        claude: &Report,
        claude_wanted: bool,
    ) {
        #[cfg(target_os = "macos")]
        let switched_off = self.login_items_off(page.is_none());
        #[cfg(not(target_os = "macos"))]
        let switched_off = false;
        #[allow(unused_mut)]
        let mut head = header(page, switched_off, claude, claude_wanted);
        // A log-in waiting for the browser says so, with this Mac's key to
        // compare with the page's.
        #[cfg(target_os = "macos")]
        if let Some(note) = crate::os::tray::log_in_note() {
            head = Header {
                dot: Dot::Amber,
                text: note,
                login_items: false,
            };
        }

        // The switches.
        let settings = page.map(|p| p.settings.clone());
        let may = settings.as_ref().is_some_and(may_change_here);
        let switch_of = |key: Key| match &settings {
            Some(s) => switch(key, s, may),
            None => Switch {
                text: key.label().to_string(),
                checked: false,
                enabled: false,
            },
        };
        self.draw_switch(Key::AwakeHold, &switch_of(Key::AwakeHold));
        self.draw_switch(
            Key::ClaudeRemoteControl,
            &switch_of(Key::ClaudeRemoteControl),
        );
        #[cfg(unix)]
        self.draw_switch(Key::Santree, &switch_of(Key::Santree));
        self.show_note(switches_note(settings.as_ref(), may));
        self.settings = settings;

        // The app's two links.
        let app = app_url();
        self.open_app.set_enabled(app.is_some());
        self.this_machine.set_enabled(app.is_some());

        // Connection, Claude, santree, Updates.
        let link = page.and_then(|p| p.controller.as_ref());
        let rows = connection_rows(link);
        self.connection.set_text(&rows.title);
        self.link.set_text(&rows.link);
        self.vpn.set_text(&rows.vpn);
        self.traffic.set_text(&rows.traffic);
        self.address.set_text(&rows.address);
        self.endpoint.set_text(&rows.endpoint);
        self.own_key.show(&rows.own_key);
        self.box_key.show(&rows.box_key);
        let policy = page.map(|p| p.policy.clone()).unwrap_or_default();
        let c = claude_rows(claude, &policy);
        self.claude.set_text(&c.title);
        self.claude_server.set_text(&c.server);
        self.claude_folder.set_text(&c.folder);
        self.restart_claude.set_text(&c.restart);
        #[cfg(unix)]
        {
            let s = santree_rows(page);
            self.santree_menu.set_text(&s.title);
            self.santree_host.set_text(&s.host);
            self.santree_open.set_text(&s.open);
            self.santree_refused.set_text(&s.refused);
        }
        self.updates.set_text(match page {
            Some(p) => update_line(p),
            None => "Updates: unknown".into(),
        });

        // The account row: log in or out (a Mac), pair (elsewhere).
        #[cfg(target_os = "macos")]
        {
            self.logged_in = page.is_some_and(|p| !logged_out(p));
            self.account.set_text(if self.logged_in {
                "Log out of the box…"
            } else {
                JOIN_LABEL
            });
            self.account.set_enabled(page.is_some());
        }
        #[cfg(not(target_os = "macos"))]
        {
            let unpaired = page.is_some_and(logged_out);
            self.account.set_text(if unpaired {
                JOIN_LABEL
            } else {
                "Paired with the box"
            });
            self.account.set_enabled(unpaired);
        }

        // The icon and its tooltip.
        let look = match (page, head.dot) {
            (None, _) => Look::Off,
            (Some(_), Dot::Green) => Look::Ok,
            (Some(_), _) => Look::Warn,
        };
        let version = page.map_or(VERSION, |p| p.version.as_str());
        let _ = self.tray.set_tooltip(Some(format!(
            "{DISPLAY_NAME} {version}\n{}\n{}",
            head.text, c.server
        )));
        self.set_look(look);
        self.set_header(head);
    }
}

/// ⌘ and `code`: a Mac's key equivalent, which works while the menu is open.
#[cfg(target_os = "macos")]
pub(super) fn cmd(
    code: tray_icon::menu::accelerator::Code,
) -> tray_icon::menu::accelerator::Accelerator {
    tray_icon::menu::accelerator::Accelerator::new(
        tray_icon::menu::accelerator::Modifiers::META,
        code,
    )
}

/// The entry that joins the box while the machine has not: a Mac logs in
/// (enroll.rs, os/macos/tray.rs `join`), every other machine pairs
/// (pair.rs, os/*/tray.rs `join`).
#[cfg(target_os = "macos")]
pub const JOIN_LABEL: &str = "Log in…";
#[cfg(not(target_os = "macos"))]
pub const JOIN_LABEL: &str = "Pair with the box…";
