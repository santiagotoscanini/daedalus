//! A machine's own settings, asked for from the machine: the menu bar's
//! switches and santree's card (local.rs `settings.get`, `settings.set`).
//!
//! **The box decides.** The box's policy (`nodes.policy`, handed down as the
//! link's `policy`) holds the settings, and nothing here applies one: the
//! machine ASKS, and a change is real only once the policy the box sends
//! back carries it. What the service keeps is what every surface shows
//! beside the kept policy — a request on its way (`pending`) and one that
//! did not take (`failed`) — so the menu bar and santree always agree.
//!
//! **What may be asked for** (`Key`): keeping the machine awake, Claude
//! Remote Control, and santree. The rest of the policy — names, providers,
//! the address pin, Claude's folder — is the box's to give, never the
//! machine's to ask for (link/wire.rs `PolicyRequest`). santree is asked
//! for in one direction only: OFF goes over the link like the others; ON
//! grants a shell on the box, so it is an admin's, in the browser — the
//! service sends nothing and answers the page to open
//! (`<app_url>/settings?tab=machines&node=<id>&santree=on`), where the
//! admin checks this machine and its key on a consent page and confirms.
//! The policy event that follows is the answer.
//!
//! **Over the link** (link/node.rs): a pending request is sent as one
//! `policy_request` of absolute values, so a retry or a replay changes
//! nothing twice. The controller acknowledges it once the app was told
//! (`ACK_WAIT`), and the app's next set carries it (`APPLY_WAIT`). Nothing
//! is queued while the link is down: a switch that flips whenever the link
//! comes back is one nobody asked for then.
//!
//! **Never silent.** Every way a request ends shows:
//!
//! | how it ends                                   | shown as                                  |
//! |-----------------------------------------------|-------------------------------------------|
//! | the kept policy carries the value             | pending cleared                           |
//! | the link is down when asked                   | failed "not connected to the box"         |
//! | not sent within `ACK_WAIT` (the link dropped)  | failed "not connected to the box"         |
//! | the controller refused it                      | failed with the controller's words        |
//! | sent, no acknowledgement within `ACK_WAIT`     | failed "the controller did not answer"    |
//! | acknowledged, not applied within `APPLY_WAIT`  | failed "Daedalus did not apply it"        |
//! | santree's page not confirmed in `BROWSER_WAIT` | pending cleared, nothing failed           |
//!
//! A failure is shown for `FAILED_KEEP`, or until the next request for the
//! same setting. Every time here is the caller's `now`, so the tests run the
//! clock themselves.

use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

use crate::link::wire::{Policy, PolicyRequest};
use crate::rpc::{ApiError, ErrorCode};

/// How long a request waits to be sent and then acknowledged.
pub const ACK_WAIT: Duration = Duration::from_secs(5);
/// How long an acknowledged request waits for the box's policy to carry it.
pub const APPLY_WAIT: Duration = Duration::from_secs(30);
/// How long santree ON waits for the admin's confirmation: the page's life.
pub const BROWSER_WAIT: Duration = Duration::from_secs(10 * 60);
/// How long a failure stays shown.
pub const FAILED_KEEP: Duration = Duration::from_secs(2 * 60);
/// The first request id a settings request takes on the link: clear of the
/// fixed ones (`hello` 1, `leave` 2; link/node.rs).
pub const FIRST_REQUEST: u64 = 1000;

/// A setting the machine may ask for.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "SettingKey"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Key {
    AwakeHold,
    ClaudeRemoteControl,
    Santree,
}

impl Key {
    pub const ALL: [Key; 3] = [Key::AwakeHold, Key::ClaudeRemoteControl, Key::Santree];

    fn index(self) -> usize {
        match self {
            Key::AwakeHold => 0,
            Key::ClaudeRemoteControl => 1,
            Key::Santree => 2,
        }
    }

    /// Its value in `p`.
    pub fn of(self, p: &Policy) -> bool {
        match self {
            Key::AwakeHold => p.awake_hold,
            Key::ClaudeRemoteControl => p.claude_remote_control,
            Key::Santree => p.santree,
        }
    }

    fn put(self, value: bool, r: &mut PolicyRequest) {
        match self {
            Key::AwakeHold => r.awake_hold = Some(value),
            Key::ClaudeRemoteControl => r.claude_remote_control = Some(value),
            Key::Santree => r.santree = Some(value),
        }
    }

    /// What the menu and santree call it.
    pub fn label(self) -> &'static str {
        match self {
            Key::AwakeHold => "Keep awake",
            Key::ClaudeRemoteControl => "Claude Remote Control",
            Key::Santree => "santree on the box",
        }
    }
}

/// Where a pending request waits: on the box (the link), or on an admin in
/// the browser (santree ON).
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "SettingVia"))]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Via {
    Box,
    Browser,
}

#[derive(Clone, Debug)]
struct Pending {
    want: bool,
    via: Via,
    since: Instant,
    /// The request id it went out under, and when.
    sent: Option<(u64, Instant)>,
    acked: Option<Instant>,
}

#[derive(Clone, Debug)]
struct Failed {
    want: bool,
    why: String,
    at: Instant,
}

/// What `ask` did.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Asked {
    /// Recorded; the link sends it now.
    Sent,
    /// The box already holds that value; nothing was sent.
    Unchanged,
    /// santree ON: nothing sent; the caller opens the confirmation page.
    Confirm,
}

/// The requests in flight and the failures shown, per setting.
#[derive(Debug, Default)]
pub struct Book {
    pending: [Option<Pending>; 3],
    failed: [Option<Failed>; 3],
    next: u64,
}

impl Book {
    /// The machine's user asks for `key` = `value` (module doc). `kept` is
    /// the policy the box last sent; `linked`, whether the link is up and
    /// approved now.
    pub fn ask(
        &mut self,
        key: Key,
        value: bool,
        kept: &Policy,
        linked: bool,
        now: Instant,
    ) -> Result<Asked, ApiError> {
        self.settle(kept, now);
        let i = key.index();
        if key == Key::Santree && value {
            if kept.santree {
                self.pending[i] = None;
                self.failed[i] = None;
                return Ok(Asked::Unchanged);
            }
            // Asked again while the page waits: the page is opened again.
            self.pending[i] = Some(Pending {
                want: true,
                via: Via::Browser,
                since: now,
                sent: None,
                acked: None,
            });
            self.failed[i] = None;
            return Ok(Asked::Confirm);
        }
        // The box holds it, and nothing else is on its way: nothing to send.
        // A request in flight for the other value is overtaken instead.
        let in_flight = self.pending[i]
            .as_ref()
            .is_some_and(|p| p.via == Via::Box && p.want != value);
        if key.of(kept) == value && !in_flight {
            self.pending[i] = None;
            self.failed[i] = None;
            return Ok(Asked::Unchanged);
        }
        if !linked {
            self.pending[i] = None;
            self.failed[i] = Some(Failed {
                want: value,
                why: NOT_CONNECTED.into(),
                at: now,
            });
            return Err(ApiError::new(ErrorCode::Unavailable, NOT_CONNECTED));
        }
        self.pending[i] = Some(Pending {
            want: value,
            via: Via::Box,
            since: now,
            sent: None,
            acked: None,
        });
        self.failed[i] = None;
        Ok(Asked::Sent)
    }

    /// The requests not yet sent, as one `policy_request` under a fresh id
    /// (link/node.rs sends it); None when there is none.
    pub fn take_request(&mut self, now: Instant) -> Option<(u64, PolicyRequest)> {
        let mut req = PolicyRequest::default();
        let mut any = false;
        for key in Key::ALL {
            if let Some(p) = &self.pending[key.index()] {
                if p.via == Via::Box && p.sent.is_none() {
                    key.put(p.want, &mut req);
                    any = true;
                }
            }
        }
        if !any {
            return None;
        }
        let id = FIRST_REQUEST + self.next;
        self.next = self.next.wrapping_add(1) % 1_000_000;
        for p in self.pending.iter_mut().flatten() {
            if p.via == Via::Box && p.sent.is_none() {
                p.sent = Some((id, now));
            }
        }
        Some((id, req))
    }

    /// Whether `id` is a settings request's (link/node.rs routes the answer).
    pub fn is_request(id: u64) -> bool {
        id >= FIRST_REQUEST
    }

    /// The controller answered request `id`: acknowledged, or refused with
    /// its words.
    pub fn answered(&mut self, id: u64, result: Result<(), String>, kept: &Policy, now: Instant) {
        for (i, slot) in self.pending.iter_mut().enumerate() {
            let Some(p) = slot else { continue };
            if p.sent.map(|(rid, _)| rid) != Some(id) {
                continue;
            }
            match &result {
                Ok(()) => p.acked = Some(now),
                Err(why) => {
                    self.failed[i] = Some(Failed {
                        want: p.want,
                        why: why.clone(),
                        at: now,
                    });
                    *slot = None;
                }
            }
        }
        self.settle(kept, now);
    }

    /// The kept policy as it stands now: a request it carries is done, one
    /// past its time has failed, a failure past `FAILED_KEEP` is forgotten.
    pub fn settle(&mut self, kept: &Policy, now: Instant) {
        for key in Key::ALL {
            let i = key.index();
            let Some(p) = &self.pending[i] else { continue };
            let have = key.of(kept);
            let failed = match p.via {
                // The admin confirmed: the policy carries it.
                Via::Browser if have => {
                    self.pending[i] = None;
                    continue;
                }
                Via::Browser if now.duration_since(p.since) >= BROWSER_WAIT => {
                    self.pending[i] = None;
                    continue;
                }
                Via::Browser => continue,
                // Carried, once the controller has passed it on: an earlier
                // value still in the policy is not this request's answer.
                Via::Box if p.acked.is_some() && have == p.want => {
                    self.pending[i] = None;
                    continue;
                }
                Via::Box => match (p.sent, p.acked) {
                    (None, _) if now.duration_since(p.since) >= ACK_WAIT => Some(NOT_CONNECTED),
                    (Some((_, at)), None) if now.duration_since(at) >= ACK_WAIT => {
                        Some("the controller did not answer")
                    }
                    (_, Some(at)) if now.duration_since(at) >= APPLY_WAIT => {
                        Some("Daedalus did not apply it")
                    }
                    _ => None,
                },
            };
            if let Some(why) = failed {
                self.failed[i] = Some(Failed {
                    want: p.want,
                    why: why.into(),
                    at: now,
                });
                self.pending[i] = None;
            }
        }
        for f in &mut self.failed {
            if f.as_ref()
                .is_some_and(|f| now.duration_since(f.at) >= FAILED_KEEP)
            {
                *f = None;
            }
        }
    }

    /// The requests in flight, as the pages show them.
    pub fn pending(&self) -> Vec<PendingView> {
        Key::ALL
            .iter()
            .filter_map(|k| {
                self.pending[k.index()].as_ref().map(|p| PendingView {
                    key: *k,
                    want: p.want,
                    via: p.via,
                })
            })
            .collect()
    }

    /// The failures shown, as the pages show them.
    pub fn failed(&self) -> Vec<FailedView> {
        Key::ALL
            .iter()
            .filter_map(|k| {
                self.failed[k.index()].as_ref().map(|f| FailedView {
                    key: *k,
                    want: f.want,
                    why: f.why.clone(),
                })
            })
            .collect()
    }
}

const NOT_CONNECTED: &str = "not connected to the box";

/// A request on its way.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "SettingPending"))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PendingView {
    pub key: Key,
    pub want: bool,
    pub via: Via,
}

/// A request that did not take, and why.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "SettingFailed"))]
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FailedView {
    pub key: Key,
    pub want: bool,
    pub why: String,
}

/// The settings as the status page, `settings.get` and the tray read them:
/// this machine's key, whether the box can be asked now, the values the
/// box keeps, what is on its way and what failed, and whose they are to
/// change.
#[cfg_attr(test, derive(ts_rs::TS))]
#[cfg_attr(test, ts(rename = "MachineSettings"))]
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
pub struct View {
    /// This machine's node id (16 hex); null before its key is loaded.
    pub node: Option<String>,
    /// Its key's fingerprint, whole, and as the menu shows it (`short`).
    pub fingerprint: Option<String>,
    pub fingerprint_short: Option<String>,
    /// The link is up and the box approved this machine: a request can go.
    pub linked: bool,
    pub awake_hold: bool,
    pub claude_remote_control: bool,
    pub santree: bool,
    pub pending: Vec<PendingView>,
    pub failed: Vec<FailedView>,
    /// Who may change them on this machine (macOS, Linux: the user who
    /// installed the agent); null where any user the socket admits may
    /// (Windows) or none is recorded.
    pub operator_uid: Option<u32>,
    pub operator: Option<String>,
    /// Whether the peer asking may change them: `settings.get` only.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[cfg_attr(test, ts(optional))]
    pub may_change: Option<bool>,
}

/// A fingerprint as the menu shows it: the first two groups and the last —
/// `f876:e2c7…8029`. Anything else goes through `short`.
pub fn short_fingerprint(fp: &str) -> String {
    let groups: Vec<&str> = fp.split(':').collect();
    if groups.len() < 4 || groups.iter().any(|g| g.is_empty()) {
        return short(fp);
    }
    format!("{}:{}…{}", groups[0], groups[1], groups[groups.len() - 1])
}

/// The menu's rule for a long value: past `SHORT_MAX` characters, the first
/// `SHORT_HEAD`, an ellipsis, and the last `SHORT_TAIL`. The whole value is
/// in the item's submenu, with Copy.
pub fn short(value: &str) -> String {
    let n = value.chars().count();
    if n <= SHORT_MAX {
        return value.to_string();
    }
    let head: String = value.chars().take(SHORT_HEAD).collect();
    let tail: String = value.chars().skip(n - SHORT_TAIL).collect();
    format!("{head}…{tail}")
}

pub const SHORT_MAX: usize = 28;
pub const SHORT_HEAD: usize = 18;
pub const SHORT_TAIL: usize = 8;

/// The page that turns santree on for machine `node`, on the app at
/// `app_url` (enroll.rs `app_url`'s form: https, no trailing slash).
pub fn confirm_url(app_url: &str, node: &str) -> String {
    format!(
        "{}/settings?tab=machines&node={node}&santree=on",
        app_url.trim_end_matches('/')
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn policy(awake: bool, claude: bool, santree: bool) -> Policy {
        Policy {
            awake_hold: awake,
            claude_remote_control: claude,
            santree,
            ..Default::default()
        }
    }

    fn at(t0: Instant, secs: u64) -> Instant {
        t0 + Duration::from_secs(secs)
    }

    #[test]
    fn a_request_is_sent_once_and_cleared_when_the_box_carries_it() {
        let t0 = Instant::now();
        let mut b = Book::default();
        let kept = policy(true, true, false);
        assert_eq!(
            b.ask(Key::AwakeHold, false, &kept, true, t0).unwrap(),
            Asked::Sent
        );
        assert_eq!(
            b.pending(),
            [PendingView {
                key: Key::AwakeHold,
                want: false,
                via: Via::Box
            }]
        );
        let (id, req) = b.take_request(t0).unwrap();
        assert!(Book::is_request(id));
        assert_eq!(
            req,
            PolicyRequest {
                awake_hold: Some(false),
                ..Default::default()
            }
        );
        // Sent once: nothing more to send.
        assert!(b.take_request(t0).is_none());
        b.answered(id, Ok(()), &kept, at(t0, 1));
        assert_eq!(b.pending().len(), 1, "acknowledged, not applied yet");
        // The box's next policy carries it.
        let applied = policy(false, true, false);
        b.settle(&applied, at(t0, 2));
        assert!(b.pending().is_empty() && b.failed().is_empty());
        // Asked for what the box holds: nothing to send.
        assert_eq!(
            b.ask(Key::AwakeHold, false, &applied, true, at(t0, 3))
                .unwrap(),
            Asked::Unchanged
        );
        assert!(b.take_request(at(t0, 3)).is_none());
    }

    #[test]
    fn two_settings_ride_one_request_and_each_id_is_new() {
        let t0 = Instant::now();
        let mut b = Book::default();
        let kept = policy(true, true, true);
        b.ask(Key::AwakeHold, false, &kept, true, t0).unwrap();
        b.ask(Key::Santree, false, &kept, true, t0).unwrap();
        let (first, req) = b.take_request(t0).unwrap();
        assert_eq!(
            req,
            PolicyRequest {
                awake_hold: Some(false),
                santree: Some(false),
                ..Default::default()
            }
        );
        b.ask(Key::ClaudeRemoteControl, false, &kept, true, t0)
            .unwrap();
        let (second, req) = b.take_request(t0).unwrap();
        assert_ne!(first, second);
        assert_eq!(req.claude_remote_control, Some(false));
        assert_eq!(req.awake_hold, None);
    }

    #[test]
    fn every_way_a_request_ends_is_shown() {
        let t0 = Instant::now();
        let kept = policy(true, true, false);
        let why = |b: &Book| b.failed().first().map(|f| f.why.clone());

        // The link is down: failed at once, nothing kept to send later.
        let mut b = Book::default();
        let e = b.ask(Key::AwakeHold, false, &kept, false, t0).unwrap_err();
        assert_eq!(e.code, ErrorCode::Unavailable);
        assert_eq!(why(&b).as_deref(), Some("not connected to the box"));
        assert!(b.take_request(t0).is_none());

        // Never sent (the link dropped before it could).
        let mut b = Book::default();
        b.ask(Key::AwakeHold, false, &kept, true, t0).unwrap();
        b.settle(&kept, at(t0, 4));
        assert!(b.failed().is_empty());
        b.settle(&kept, at(t0, 5));
        assert_eq!(why(&b).as_deref(), Some("not connected to the box"));

        // The controller refused it, in its words.
        let mut b = Book::default();
        b.ask(Key::AwakeHold, false, &kept, true, t0).unwrap();
        let (id, _) = b.take_request(t0).unwrap();
        b.answered(id, Err("Daedalus is not listening".into()), &kept, t0);
        assert_eq!(why(&b).as_deref(), Some("Daedalus is not listening"));
        assert!(b.pending().is_empty());
        assert!(!b.failed()[0].want);

        // Sent, never acknowledged.
        let mut b = Book::default();
        b.ask(Key::AwakeHold, false, &kept, true, t0).unwrap();
        b.take_request(at(t0, 1)).unwrap();
        b.settle(&kept, at(t0, 5));
        assert!(b.failed().is_empty());
        b.settle(&kept, at(t0, 6));
        assert_eq!(why(&b).as_deref(), Some("the controller did not answer"));

        // Acknowledged, never applied.
        let mut b = Book::default();
        b.ask(Key::AwakeHold, false, &kept, true, t0).unwrap();
        let (id, _) = b.take_request(t0).unwrap();
        b.answered(id, Ok(()), &kept, at(t0, 1));
        b.settle(&kept, at(t0, 30));
        assert!(b.failed().is_empty());
        b.settle(&kept, at(t0, 31));
        assert_eq!(why(&b).as_deref(), Some("Daedalus did not apply it"));
        // A failure is shown for two minutes, then forgotten…
        b.settle(&kept, at(t0, 31 + 119));
        assert_eq!(b.failed().len(), 1);
        b.settle(&kept, at(t0, 31 + 120));
        assert!(b.failed().is_empty());
        // …or until the next request for it.
        b.ask(Key::AwakeHold, false, &kept, false, at(t0, 200))
            .unwrap_err();
        b.ask(Key::AwakeHold, false, &kept, true, at(t0, 201))
            .unwrap();
        assert!(b.failed().is_empty());
    }

    #[test]
    fn an_earlier_value_in_the_policy_is_not_the_answer() {
        let t0 = Instant::now();
        let mut b = Book::default();
        // On, then off again before the box answered: the second overtakes
        // the first, though the kept policy already says off.
        let off = policy(false, true, false);
        b.ask(Key::AwakeHold, true, &off, true, t0).unwrap();
        let (first, _) = b.take_request(t0).unwrap();
        assert_eq!(
            b.ask(Key::AwakeHold, false, &off, true, t0).unwrap(),
            Asked::Sent
        );
        let (second, req) = b.take_request(t0).unwrap();
        assert_eq!(req.awake_hold, Some(false));
        // The first's answer is not the second's.
        b.answered(first, Ok(()), &off, at(t0, 1));
        assert_eq!(b.pending().len(), 1);
        b.answered(second, Ok(()), &off, at(t0, 1));
        assert!(b.pending().is_empty() && b.failed().is_empty());
    }

    #[test]
    fn santree_on_waits_for_the_browser_and_sends_nothing() {
        let t0 = Instant::now();
        let mut b = Book::default();
        let off = policy(true, true, false);
        assert_eq!(
            b.ask(Key::Santree, true, &off, true, t0).unwrap(),
            Asked::Confirm
        );
        // Even unlinked: the page is the way.
        assert_eq!(
            b.ask(Key::Santree, true, &off, false, t0).unwrap(),
            Asked::Confirm
        );
        assert!(b.take_request(t0).is_none(), "nothing on the link");
        assert_eq!(b.pending()[0].via, Via::Browser);
        // Not confirmed in ten minutes: dropped, nothing failed.
        b.settle(&off, at(t0, 599));
        assert_eq!(b.pending().len(), 1);
        b.settle(&off, at(t0, 600));
        assert!(b.pending().is_empty() && b.failed().is_empty());
        // Confirmed: the policy carries it.
        b.ask(Key::Santree, true, &off, true, at(t0, 700)).unwrap();
        b.settle(&policy(true, true, true), at(t0, 701));
        assert!(b.pending().is_empty());
        // Already on: unchanged.
        assert_eq!(
            b.ask(Key::Santree, true, &policy(true, true, true), true, t0)
                .unwrap(),
            Asked::Unchanged
        );
        // OFF goes over the link like the others.
        assert_eq!(
            b.ask(Key::Santree, false, &policy(true, true, true), true, t0)
                .unwrap(),
            Asked::Sent
        );
        assert_eq!(b.take_request(t0).unwrap().1.santree, Some(false));
    }

    #[test]
    fn the_shortening_rule() {
        assert_eq!(
            short_fingerprint(
                "f876:e2c7:1a0b:2c3d:4e5f:6a7b:8c9d:0e1f:2a3b:4c5d:6e7f:8a9b:0c1d:2e3f:4a5b:8029"
            ),
            "f876:e2c7…8029"
        );
        assert_eq!(short("box.lan:7788"), "box.lan:7788");
        let exactly = "a".repeat(SHORT_MAX);
        assert_eq!(short(&exactly), exactly);
        let long = "averyveryverylonghostname.example.org:51820";
        let s = short(long);
        assert_eq!(s, "averyveryverylongh…rg:51820");
        assert_eq!(s.chars().count(), SHORT_HEAD + 1 + SHORT_TAIL);
        // Not a fingerprint: the general rule.
        assert_eq!(short_fingerprint("abc"), "abc");
        // Characters, never bytes: no panic on a multi-byte one.
        assert_eq!(short(&"é".repeat(40)).chars().count(), 27);
        assert_eq!(
            confirm_url("https://daedalus-app.example.org", "0123456789abcdef"),
            "https://daedalus-app.example.org/settings?tab=machines&node=0123456789abcdef&santree=on"
        );
    }
}
