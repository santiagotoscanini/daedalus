//! Pairing: naming the controller this machine trusts, after the install
//! (as `tailscale up` follows Tailscale's). A machine installed without a
//! pin runs **unpaired**: the service is up and the tray shows it, but it
//! dials nobody and trusts no key (link/node.rs) — nothing is learned from
//! whoever answers first. Pairing writes config.toml's `controller_pin`,
//! and `controller_address` when one is named (without one the address
//! stays config.toml's, else DNS's), through the one writer `install`
//! uses (config.rs `write_link_config_at`), then hands the running service
//! the new keys (`reload`) and the link starts over under them. That is
//! Windows' and Linux's way; a Mac logs in instead (enroll.rs), and `pair`
//! and `install --pin` refuse there.
//!
//! Three doors, one path:
//!
//! - `daedalus-agent pair --pin KEY [--controller HOST:PORT]`, as root or an
//!   administrator like `install`: writes config.toml itself, then asks the
//!   service to read it again (`link.reload` on the local socket). It
//!   re-pins a paired machine too — moving the trust is an administrator's.
//! - `install --pin`: the same keys through the same writer, before the
//!   service starts.
//! - the tray's "Pair with the box…" (`parse_pasted`, tray.rs
//!   `pair_pasted`): the same verb, run elevated behind the OS's own prompt
//!   (UAC, polkit), with the pasted text
//!   checked here first. The tray runs as the user and config.toml is the
//!   service's, and naming the controller hands that controller the
//!   service's privileges, so pairing asks what `install` asks: an
//!   administrator. The local socket has no pairing method.

use std::path::Path;

use anyhow::{bail, Context, Result};

use crate::config::{valid_host_port, Config};
use crate::identity::{format_fingerprint, parse_fingerprint};
use crate::link::LinkKeys;
use crate::shared::Shared;

/// A controller to trust, checked: the pin a fingerprint, the address
/// (when there is one) host:port.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pairing {
    /// Formatted as identity.rs formats it, whatever the paste looked like.
    pub pin: String,
    pub controller: Option<String>,
}

impl Pairing {
    pub fn new(pin: &str, controller: Option<&str>) -> Result<Self> {
        let d = parse_fingerprint(pin.trim())
            .context("the pin is not a controller key (Settings › Machines shows it)")?;
        Ok(Self {
            pin: format_fingerprint(&d),
            controller: check_controller(controller)?,
        })
    }

    /// Write both keys into the config.toml at `path` (module doc).
    pub fn write_at(&self, path: &Path) -> Result<()> {
        let cfg = Config {
            controller_pin: Some(self.pin.clone()),
            controller_address: self.controller.clone(),
            ..Config::default()
        };
        crate::config::write_link_config_at(path, &cfg)
    }
}

fn check_controller(c: Option<&str>) -> Result<Option<String>> {
    match c.map(str::trim).filter(|c| !c.is_empty()) {
        None => Ok(None),
        Some(c) if valid_host_port(c) => Ok(Some(c.to_string())),
        Some(c) => {
            bail!("--controller must be host:port (the controller's link address), not {c:?}")
        }
    }
}

/// `--pin KEY` and `--controller HOST:PORT`, both optional, both checked:
/// what `install` and `pair` take.
pub fn parse_args(args: &[String]) -> Result<(Option<Pairing>, Option<String>)> {
    let (mut pin, mut controller) = (None, None);
    let mut it = args.iter();
    while let Some(a) = it.next() {
        match a.as_str() {
            "--controller" => {
                controller = Some(it.next().context("--controller needs host:port")?.clone());
            }
            "--pin" => {
                pin = Some(
                    it.next()
                        .context("--pin needs the controller key's fingerprint")?
                        .clone(),
                );
            }
            other => bail!("unknown option {other}"),
        }
    }
    let controller = check_controller(controller.as_deref())?;
    let pairing = match pin {
        Some(p) => Some(Pairing::new(&p, controller.as_deref())?),
        None => None,
    };
    Ok((pairing, controller))
}

/// What someone pasted into the tray's box (Windows and Linux: a Mac signs
/// in instead, enroll.rs): the key alone, the key and
/// `host:port`, or a whole `pair` or install line from Settings › Machines
/// (`--pin`/`-Pin`, `--controller`/`-Controller`, quoted or not).
#[cfg(not(target_os = "macos"))]
pub fn parse_pasted(text: &str) -> Result<Pairing> {
    let words: Vec<&str> = text
        .split_whitespace()
        .map(|w| w.trim_matches(|c| matches!(c, '\'' | '"' | '`' | ';')))
        .filter(|w| !w.is_empty())
        .collect();
    let (mut pin, mut controller) = (None, None);
    let mut i = 0;
    while i < words.len() {
        match words[i] {
            "--pin" | "-Pin" => {
                pin = words.get(i + 1).copied();
                i += 2;
                continue;
            }
            "--controller" | "-Controller" => {
                controller = words.get(i + 1).copied();
                i += 2;
                continue;
            }
            w if pin.is_none() && parse_fingerprint(w).is_ok() => pin = Some(w),
            w if controller.is_none() && valid_host_port(w) => controller = Some(w),
            _ => {}
        }
        i += 1;
    }
    let Some(pin) = pin else {
        bail!("no controller key in what was pasted: copy it from Settings › Machines")
    };
    Pairing::new(pin, controller)
}

/// Whether the config.toml at `path` names a pin (an absent file does not).
pub fn paired_at(path: &Path) -> Result<bool> {
    Ok(LinkKeys::of(&crate::config::load_at(path)?).paired())
}

/// Whether pairing with `pin` moves the config.toml at `path` to another
/// controller key than the one it trusts (or trusted none): then the kept
/// santree grant, the last box's, goes too (paths.rs `forget_santree`).
pub fn moves_pin(path: &Path, pin: &str) -> bool {
    let key = |p: &str| parse_fingerprint(p.trim()).ok();
    let held = crate::config::load_at(path)
        .ok()
        .and_then(|c| c.controller_pin)
        .and_then(|p| key(&p));
    held.is_none() || held != key(pin)
}

/// Read config.toml's link keys again and hand them to the running link;
/// true when they moved (and the link starts over under them).
pub fn reload(shared: &Shared, path: &Path) -> Result<bool> {
    Ok(shared.set_link_keys(LinkKeys::of(&crate::config::load_at(path)?)))
}

/// The `pair` command as this OS's administrator types it.
pub fn command_line(pin: &str, controller: Option<&str>) -> String {
    let tail = match controller {
        Some(c) => format!(" --controller {c}"),
        None => String::new(),
    };
    if cfg!(windows) {
        format!(
            "& \"$env:ProgramFiles\\daedalus-agent\\daedalus-agent.exe\" pair --pin {pin}{tail} \
             (an administrator PowerShell)"
        )
    } else {
        format!("sudo daedalus-agent pair --pin {pin}{tail}")
    }
}

/// What an unpaired machine says on the terminal (`install`, `status`); a
/// Mac, which logs in instead (enroll.rs), says how.
pub fn unpaired_hint() -> String {
    if cfg!(target_os = "macos") {
        return "logged out: this Mac reaches no box until it logs in — the daedalus mark in \
                the menu bar › \"Log in…\"."
            .into();
    }
    format!(
        "not paired: this machine trusts no controller yet, so it connects to none. Copy the \
         controller key from Settings › Machines, then run\n  {}\nor use \"Pair with the \
         box…\" in the tray.",
        command_line("<key>", None)
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::Mode;
    use crate::role::Role;
    use std::sync::Arc;
    use std::time::Instant;

    fn fp(n: u8) -> String {
        format_fingerprint(&[n; 32])
    }

    fn scratch(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("daedalus-pair-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    fn node_shared() -> Arc<Shared> {
        Arc::new(Shared::new(
            crate::state::State::default(),
            crate::facts::Facts::default(),
            Instant::now(),
            crate::link::wire::Policy::default(),
            Role::of(Mode::Node),
        ))
    }

    #[test]
    fn a_pin_must_be_a_fingerprint_and_an_address_host_port() {
        let key = fp(7);
        // Whatever the case and separators, it is stored as identity.rs shows it.
        let loose = key.to_ascii_uppercase().replace(':', "");
        assert_eq!(Pairing::new(&loose, None).unwrap().pin, key);
        assert!(Pairing::new("3f2a:9c01", None).is_err());
        assert!(Pairing::new("", None).is_err());
        assert!(Pairing::new(&key, Some("box.lan")).is_err());
        assert!(Pairing::new(&key, Some("box.lan:0")).is_err());
        assert!(Pairing::new(&key, Some("$(reboot):1")).is_err());
        assert_eq!(
            Pairing::new(&key, Some(" box.lan:7788 "))
                .unwrap()
                .controller
                .as_deref(),
            Some("box.lan:7788")
        );

        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let (p, c) = parse_args(&args(&["--pin", &key, "--controller", "box.lan:7788"])).unwrap();
        assert_eq!(p.unwrap().controller.as_deref(), Some("box.lan:7788"));
        assert_eq!(c.as_deref(), Some("box.lan:7788"));
        // install takes neither; a controller alone is kept.
        assert_eq!(parse_args(&[]).unwrap(), (None, None));
        let (p, c) = parse_args(&args(&["--controller", "box.lan:7788"])).unwrap();
        assert!(p.is_none() && c.is_some());
        assert!(parse_args(&args(&["--pin"])).is_err());
        assert!(parse_args(&args(&["--pin", "nope"])).is_err());
        assert!(parse_args(&args(&["--force"])).is_err());
    }

    #[cfg(not(target_os = "macos"))]
    #[test]
    fn a_paste_is_the_key_or_a_whole_line() {
        let key = fp(9);
        assert_eq!(parse_pasted(&format!("  {key}\n")).unwrap().pin, key);
        let both = parse_pasted(&format!("{key} box.lan:7788")).unwrap();
        assert_eq!(both.controller.as_deref(), Some("box.lan:7788"));
        let unix = format!(
            "curl -fsSL https://daedalus.toscanini.me/install.sh | sudo sh -s -- --controller 'box.lan:7788' --pin '{key}'"
        );
        assert_eq!(parse_pasted(&unix).unwrap(), both);
        let ps = format!(
            "Set-ExecutionPolicy -Scope Process Bypass -Force; & ([scriptblock]::Create((irm https://daedalus.toscanini.me/install.ps1))) -Controller 'box.lan:7788' -Pin '{key}'"
        );
        assert_eq!(parse_pasted(&ps).unwrap(), both);
        let pair = format!("sudo daedalus-agent pair --pin {key}");
        assert_eq!(parse_pasted(&pair).unwrap().controller, None);
        assert!(parse_pasted("").is_err());
        assert!(parse_pasted("hello box.lan:7788").is_err());
        assert!(parse_pasted(&format!("--pin {key} --controller nope")).is_err());
    }

    #[test]
    fn pairing_writes_config_toml_in_place_and_reloads_the_link() {
        let dir = scratch("write");
        let path = dir.join("config.toml");
        // A machine installed unpaired: its file, with an operator's comment.
        std::fs::write(&path, "# mine\ntelemetry = \"minimal\"\n").unwrap();
        assert!(!paired_at(&path).unwrap());
        let shared = node_shared();
        let p = Pairing::new(&fp(1), Some("box.lan:7788")).unwrap();
        p.write_at(&path).unwrap();
        assert!(reload(&shared, &path).unwrap());
        let text = std::fs::read_to_string(&path).unwrap();
        assert!(
            text.starts_with("# mine\ntelemetry = \"minimal\"\n"),
            "{text}"
        );
        let cfg: Config = toml::from_str(&text).unwrap();
        assert_eq!(cfg.controller_pin.as_deref(), Some(fp(1).as_str()));
        assert_eq!(cfg.controller_address.as_deref(), Some("box.lan:7788"));
        assert!(paired_at(&path).unwrap());
        let (keys, moved) = shared.link_keys();
        assert_eq!((keys.pin.as_deref(), moved), (Some(fp(1).as_str()), 1));
        // Written whole, and the service's: no stray temp file, and on unix
        // not writable by group or others.
        let names: Vec<_> = std::fs::read_dir(&dir)
            .unwrap()
            .map(|e| e.unwrap().file_name())
            .collect();
        assert_eq!(names, vec![std::ffi::OsString::from("config.toml")]);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&path).unwrap().permissions().mode();
            assert_eq!(mode & 0o022, 0, "{mode:o}");
        }

        // An administrator's re-pin (the verb) writes over it, keeping the
        // address; a reload that finds nothing new moves nothing.
        let other = Pairing::new(&fp(2), None).unwrap();
        other.write_at(&path).unwrap();
        assert!(reload(&shared, &path).unwrap());
        assert!(!reload(&shared, &path).unwrap());
        let (keys, moved) = shared.link_keys();
        assert_eq!(keys.pin.as_deref(), Some(fp(2).as_str()));
        assert_eq!(keys.address.as_deref(), Some("box.lan:7788"));
        assert_eq!(moved, 2);

        // A machine never installed gets the whole default file.
        let fresh = scratch("fresh").join("config.toml");
        p.write_at(&fresh).unwrap();
        assert!(paired_at(&fresh).unwrap());
        for d in [dir, fresh.parent().unwrap().to_path_buf()] {
            let _ = std::fs::remove_dir_all(d);
        }
    }

    #[test]
    fn a_pin_moves_to_another_box_or_stays() {
        let dir = scratch("moves");
        let path = dir.join("config.toml");
        // Unpaired (no file, or no pin): any pin moves it.
        assert!(moves_pin(&path, &fp(1)));
        Pairing::new(&fp(1), None).unwrap().write_at(&path).unwrap();
        assert!(!moves_pin(&path, &fp(1)));
        // The same key however it is written.
        assert!(!moves_pin(&path, &fp(1).to_uppercase()));
        assert!(moves_pin(&path, &fp(2)));
        let _ = std::fs::remove_dir_all(dir);
    }
}
