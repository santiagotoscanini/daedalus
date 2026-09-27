//! One connection: lines in, answers and events out.
//!
//! The reading thread takes a line at a time (at most `MAX_LINE`), answers
//! `hello` and `events.subscribe` itself — they belong to the connection —
//! and hands every other request to a thread of its own, so a slow method
//! never holds up the next one. Answers and events share one writer behind
//! a lock, a whole line per write. When the peer closes, the reader stops,
//! waits for the requests still running, and the event thread follows.
//!
//! A write that fails — on the socket, one that did not complete within
//! the write timeout the os layer set, a peer that stopped reading — marks
//! the connection broken and tears the transport down (`Conn::close`),
//! which also ends a read blocked on a peer that will never send again: no
//! peer can pin this function.
//!
//! Generic over the transport (`Conn`), so the tests drive it with
//! in-memory halves on every OS; os `serve_local_socket` hands it a unix
//! socket.

use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::mpsc::RecvTimeoutError;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::Value;

use super::wire::{code, hello_api, ApiError, HelloParams, Request, Response, Subscribed};
use super::{Api, API_VERSION, MAX_LINE};

/// How much of a client's self-description reaches the log.
const CLIENT_LOGGED: usize = 64;

/// One connection's transport, as the os layer hands it over.
pub struct Conn {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    /// `hello` was answered: lift the deadline the first line had.
    pub on_hello: Box<dyn FnOnce() + Send>,
    /// Tear the transport down both ways: a blocked read returns, and the
    /// peer sees the connection end.
    pub close: Arc<dyn Fn() + Send + Sync>,
}

impl Conn {
    /// Two halves with no deadline to lift and nothing to tear down beyond
    /// dropping them (the tests' in-memory transports).
    pub fn plain(reader: impl Read + Send + 'static, writer: impl Write + Send + 'static) -> Self {
        Self {
            reader: Box::new(reader),
            writer: Box::new(writer),
            on_hello: Box::new(|| {}),
            close: Arc::new(|| {}),
        }
    }
}

/// The writing half, shared by the answers and the events.
struct Out {
    writer: Mutex<Box<dyn Write + Send>>,
    /// A write failed: the peer is gone, and nothing more is written.
    broken: AtomicBool,
    close: Arc<dyn Fn() + Send + Sync>,
}

impl Out {
    fn send<T: Serialize>(&self, v: &T) {
        match serde_json::to_string(v) {
            Ok(line) => self.line(&line),
            Err(e) => tracing::warn!(error = %e, "api: an answer did not serialise"),
        }
    }

    fn line(&self, line: &str) {
        if self.broken.load(Ordering::Relaxed) {
            return;
        }
        let mut w = self.writer.lock().unwrap_or_else(|p| p.into_inner());
        let ok = w
            .write_all(line.as_bytes())
            .and_then(|()| w.write_all(b"\n"))
            .and_then(|()| w.flush());
        if let Err(e) = ok {
            drop(w);
            if !self.broken.swap(true, Ordering::Relaxed) {
                tracing::info!(error = %e, "api: a write failed; closing the connection");
                (self.close)();
            }
        }
    }
}

/// What reading one line gave.
enum Line {
    Text(Vec<u8>),
    TooLong,
    End,
}

fn read_line<R: BufRead>(r: &mut R) -> Line {
    let mut buf = Vec::new();
    match r.take(MAX_LINE as u64 + 1).read_until(b'\n', &mut buf) {
        // End of stream, a read error, or the pre-hello deadline passing.
        Ok(0) | Err(_) => Line::End,
        Ok(_) => {
            if buf.last() == Some(&b'\n') {
                buf.pop();
                if buf.last() == Some(&b'\r') {
                    buf.pop();
                }
            }
            if buf.len() > MAX_LINE {
                Line::TooLong
            } else {
                Line::Text(buf)
            }
        }
    }
}

/// The `id` of something that is not a valid request, when it has one, so
/// the error can still be matched to it.
fn salvage_id(text: &[u8]) -> Option<u64> {
    serde_json::from_slice::<Value>(text)
        .ok()?
        .get("id")?
        .as_u64()
}

/// `hello`'s answer: the version first, from the raw parameters, so any
/// client of another version is told which one this agent speaks whatever
/// else it sent; then the parameters, leniently (wire.rs).
fn hello(api: &Api, id: u64, p: Value) -> Result<(Response, String), Response> {
    let asked = hello_api(&p);
    if let Some(v) = asked.filter(|v| *v != u64::from(API_VERSION)) {
        return Err(Response::err(
            Some(id),
            ApiError {
                supported: Some(API_VERSION),
                ..ApiError::new(
                    code::VERSION,
                    format!(
                        "this agent speaks api {API_VERSION}, not {v}; {} is version {}",
                        crate::SERVICE_NAME,
                        crate::VERSION
                    ),
                )
            },
        ));
    }
    match serde_json::from_value::<HelloParams>(p) {
        Ok(h) => Ok((Response::ok(id, &api.hello()), h.client)),
        Err(e) => Err(Response::err(
            Some(id),
            ApiError::new(code::BAD_REQUEST, format!("hello: {e}")),
        )),
    }
}

/// A client's self-description, cut for the log.
fn logged(client: &str) -> String {
    client.chars().take(CLIENT_LOGGED).collect()
}

/// Serve one connection until the peer closes it, a write fails, or the
/// first line does not come in time.
pub fn serve_connection(api: Arc<Api>, conn: Conn) {
    let Conn {
        reader,
        writer,
        on_hello,
        close,
    } = conn;
    let out = Arc::new(Out {
        writer: Mutex::new(writer),
        broken: AtomicBool::new(false),
        close: Arc::clone(&close),
    });
    let closed = Arc::new(AtomicBool::new(false));
    let in_flight = Arc::new(AtomicUsize::new(0));
    let max_in_flight = api.max_in_flight();
    let mut requests = Vec::new();
    let mut events = None;
    let mut client: Option<String> = None;
    let mut on_hello = Some(on_hello);
    let mut reader = BufReader::new(reader);

    loop {
        if out.broken.load(Ordering::Relaxed) {
            break;
        }
        let text = match read_line(&mut reader) {
            Line::End => break,
            Line::TooLong => {
                out.send(&Response::err(
                    None,
                    ApiError::new(
                        code::TOO_LARGE,
                        format!("a line is at most {MAX_LINE} bytes; closing"),
                    ),
                ));
                break;
            }
            Line::Text(t) if t.iter().all(u8::is_ascii_whitespace) => continue,
            Line::Text(t) => t,
        };
        let req = match Request::parse(&text) {
            Ok(r) => r,
            Err(e) => {
                out.send(&Response::err(
                    salvage_id(&text),
                    ApiError::new(code::BAD_REQUEST, format!("not a request: {e}")),
                ));
                continue;
            }
        };
        let id = req.id;

        if req.m == "hello" {
            match hello(&api, id, req.p) {
                Ok((answer, name)) => {
                    if client.is_none() {
                        tracing::info!(client = %logged(&name), "api: client connected");
                    }
                    client = Some(logged(&name));
                    if let Some(lift) = on_hello.take() {
                        lift();
                    }
                    out.send(&answer);
                }
                Err(refused) => out.send(&refused),
            }
            continue;
        }
        if client.is_none() {
            out.send(&Response::err(
                Some(id),
                ApiError::new(
                    code::BAD_REQUEST,
                    format!("the first request must be `hello` (api {API_VERSION})"),
                ),
            ));
            continue;
        }

        if req.m == "events.subscribe" {
            match &req.p {
                Value::Null => {}
                Value::Object(m) if m.is_empty() => {}
                _ => {
                    out.send(&Response::err(
                        Some(id),
                        ApiError::new(code::BAD_REQUEST, "`events.subscribe` takes no parameters"),
                    ));
                    continue;
                }
            }
            // Subscribed before the answer goes out, so no event can fall
            // between the two; the thread starts after it, so none comes
            // before it.
            let rx = events.is_none().then(|| api.events().subscribe());
            out.send(&Response::ok(id, &Subscribed {}));
            if let Some(rx) = rx {
                let out = Arc::clone(&out);
                let closed = Arc::clone(&closed);
                events = std::thread::Builder::new()
                    .name("api-events".into())
                    .spawn(move || loop {
                        if closed.load(Ordering::Relaxed) || out.broken.load(Ordering::Relaxed) {
                            return;
                        }
                        match rx.recv_timeout(Duration::from_millis(200)) {
                            Ok(line) => out.line(&line),
                            Err(RecvTimeoutError::Timeout) => {}
                            Err(RecvTimeoutError::Disconnected) => return,
                        }
                    })
                    .ok();
            }
            continue;
        }

        if in_flight.fetch_add(1, Ordering::AcqRel) >= max_in_flight {
            in_flight.fetch_sub(1, Ordering::AcqRel);
            out.send(&Response::err(
                Some(id),
                ApiError::new(
                    code::BUSY,
                    format!("at most {max_in_flight} requests in flight on one connection"),
                ),
            ));
            continue;
        }
        let (api, out_req, flight) = (Arc::clone(&api), Arc::clone(&out), Arc::clone(&in_flight));
        let spawned = std::thread::Builder::new()
            .name("api-request".into())
            .spawn(move || {
                let response = match api.call(&req.m, &req.p) {
                    Ok(v) => Response::raw(id, v),
                    Err(e) => Response::err(Some(id), e),
                };
                out_req.send(&response);
                flight.fetch_sub(1, Ordering::AcqRel);
            });
        match spawned {
            Ok(h) => requests.push(h),
            Err(e) => {
                in_flight.fetch_sub(1, Ordering::AcqRel);
                out.send(&Response::err(
                    Some(id),
                    ApiError::new(code::BUSY, format!("no thread for the request: {e}")),
                ));
            }
        }
        requests.retain(|h| !h.is_finished());
    }

    // Answers still owed are written (or fail within the write timeout)
    // before the transport goes.
    for h in requests {
        let _ = h.join();
    }
    closed.store(true, Ordering::Relaxed);
    if let Some(h) = events {
        let _ = h.join();
    }
    close();
    if let Some(c) = client {
        tracing::info!(client = %c, "api: client left");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::claude::Report;
    use crate::config::Config;
    use crate::status::Shared;
    use serde_json::json;
    use std::time::Instant;

    /// A writer the test can read back after the connection ends.
    #[derive(Clone, Default)]
    struct Sink(Arc<Mutex<Vec<u8>>>);

    impl Write for Sink {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Sink {
        fn lines(&self) -> Vec<Value> {
            String::from_utf8(self.0.lock().unwrap().clone())
                .unwrap()
                .lines()
                .map(|l| serde_json::from_str(l).unwrap())
                .collect()
        }
    }

    fn controller(extra: &str) -> (Arc<Shared>, Arc<Api>) {
        let cfg: Config = toml::from_str(&format!("mode = \"controller\"\n{extra}")).unwrap();
        let shared = Arc::new(Shared::new(
            crate::state::State::default(),
            crate::facts::Facts::default(),
            Instant::now(),
            cfg.initial_policy(),
            cfg.role(),
        ));
        let api = Arc::new(Api::new(Arc::clone(&shared), &cfg));
        (shared, api)
    }

    /// Run a whole conversation and return the lines written, answers
    /// sorted by id (they may come back in any order) with events after.
    fn talk(api: Arc<Api>, input: &str) -> Vec<Value> {
        let sink = Sink::default();
        serve_connection(
            api,
            Conn::plain(std::io::Cursor::new(input.to_string()), sink.clone()),
        );
        let mut lines = sink.lines();
        lines.sort_by_key(|v| v.get("id").and_then(Value::as_u64).unwrap_or(u64::MAX));
        lines
    }

    const HELLO: &str = r#"{"id":1,"m":"hello","p":{"api":1,"client":"test/1"}}"#;

    #[test]
    fn hello_comes_first_and_names_the_version() {
        let (_, api) = controller("");
        let out = talk(
            api,
            &[
                r#"{"id":1,"m":"system.info"}"#,
                r#"{"id":2,"m":"hello","p":{"api":2,"client":"future/9"}}"#,
                r#"{"id":3,"m":"hello","p":{"api":1}}"#,
                r#"{"id":4,"m":"hello","p":{"api":1,"client":"test/1"}}"#,
                r#"{"id":5,"m":"system.info"}"#,
            ]
            .join("\n"),
        );
        assert_eq!(out[0]["err"]["code"], "bad_request");
        assert!(out[0]["err"]["msg"].as_str().unwrap().contains("hello"));
        assert_eq!(out[1]["err"]["code"], "version");
        assert_eq!(out[1]["err"]["supported"], 1);
        assert_eq!(out[2]["err"]["code"], "bad_request");
        assert_eq!(out[3]["ok"]["api"], 1);
        assert_eq!(out[3]["ok"]["mode"], "controller");
        assert_eq!(out[3]["ok"]["version"], crate::VERSION);
        assert_eq!(
            out[3]["ok"]["capabilities"],
            json!(["claude.remote_control", "telemetry.full"])
        );
        assert_eq!(out[4]["ok"]["mode"], "controller");
        assert_eq!(out[4]["ok"]["role"]["api_socket"], true);
        assert_eq!(out[4]["ok"]["role"]["claude_update"], false);
    }

    #[test]
    fn the_bytes_on_the_wire_are_the_types_own() {
        // Field order as wire.rs declares it — what the golden tests pin.
        let (_, api) = controller("");
        let sink = Sink::default();
        let input = format!("{HELLO}\n{}\n", r#"{"id":2,"m":"telemetry.get"}"#);
        serve_connection(api, Conn::plain(std::io::Cursor::new(input), sink.clone()));
        let text = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        let mut lines: Vec<&str> = text.lines().collect();
        lines.sort();
        assert!(
            lines[0].starts_with(r#"{"id":1,"ok":{"api":1,"version":""#),
            "{}",
            lines[0]
        );
        assert_eq!(
            lines[1],
            r#"{"id":2,"ok":{"level":"full","telemetry":null}}"#
        );
    }

    /// The raw lines a conversation wrote, in the order written.
    fn raw(api: Arc<Api>, input: &str) -> Vec<String> {
        let sink = Sink::default();
        serve_connection(
            api,
            Conn::plain(std::io::Cursor::new(input.to_string()), sink.clone()),
        );
        let text = String::from_utf8(sink.0.lock().unwrap().clone()).unwrap();
        text.lines().map(str::to_string).collect()
    }

    #[test]
    fn a_newer_client_is_told_the_version_whatever_else_it_sends() {
        let (_, api) = controller("");
        let v = crate::VERSION;
        let out = raw(
            Arc::clone(&api),
            &[
                r#"{"id":1,"m":"hello","trace":"t","p":{"api":2,"client":"app/9","features":["x"],"auth":{"k":1}}}"#,
                r#"{"id":2,"m":"hello","p":{"api":2}}"#,
                r#"{"id":3,"m":"hello","trace":"t","p":{"api":1,"client":"app/1","features":["x"]}}"#,
            ]
            .join("\n"),
        );
        let version = |id: u64| {
            format!(
                "{{\"id\":{id},\"err\":{{\"code\":\"version\",\"msg\":\"this agent speaks api 1, not 2; \
                 daedalus-agent is version {v}\",\"supported\":1}}}}"
            )
        };
        assert_eq!(out[0], version(1));
        assert_eq!(out[1], version(2));
        assert!(
            out[2].starts_with(r#"{"id":3,"ok":{"api":1,"#),
            "{}",
            out[2]
        );
    }

    #[test]
    fn too_large_and_busy_lines_are_pinned() {
        let (_, api) = controller("");
        let long = format!("{}\n", "x".repeat(MAX_LINE + 1));
        assert_eq!(
            raw(Arc::clone(&api), &long),
            [
                r#"{"id":null,"err":{"code":"too_large","msg":"a line is at most 1048576 bytes; closing"}}"#
            ]
        );
        // No room in flight: every request past hello is `busy`.
        let full = Arc::new(Arc::into_inner(api).unwrap().with_max_in_flight(0));
        let out = raw(full, &[HELLO, r#"{"id":2,"m":"system.info"}"#].join("\n"));
        assert_eq!(
            out[1],
            r#"{"id":2,"err":{"code":"busy","msg":"at most 0 requests in flight on one connection"}}"#
        );
    }

    #[test]
    fn a_peer_that_stops_reading_cannot_pin_the_connection() {
        /// A writer that fails, as a socket does when its write timeout
        /// passes with the peer not reading.
        struct Stuck;
        impl Write for Stuck {
            fn write(&mut self, _: &[u8]) -> std::io::Result<usize> {
                Err(std::io::ErrorKind::WouldBlock.into())
            }
            fn flush(&mut self) -> std::io::Result<()> {
                Ok(())
            }
        }
        let (_, api) = controller("");
        // The reader blocks until `close` hangs its sender up — as a read on
        // a socket does until it is shut down.
        let (reader, feed) = pipe();
        let feed = Arc::new(Mutex::new(Some(feed)));
        feed.lock()
            .unwrap()
            .as_ref()
            .unwrap()
            .send(format!("{HELLO}\n").into_bytes())
            .unwrap();
        let closed = Arc::new(AtomicUsize::new(0));
        let conn = Conn {
            reader: Box::new(reader),
            writer: Box::new(Stuck),
            on_hello: Box::new(|| {}),
            close: {
                let (feed, closed) = (Arc::clone(&feed), Arc::clone(&closed));
                Arc::new(move || {
                    closed.fetch_add(1, Ordering::SeqCst);
                    feed.lock().unwrap().take();
                })
            },
        };
        let done = std::thread::spawn(move || serve_connection(api, conn));
        let until = Instant::now() + Duration::from_secs(5);
        while !done.is_finished() {
            assert!(Instant::now() < until, "serve_connection is pinned");
            std::thread::sleep(Duration::from_millis(10));
        }
        done.join().unwrap();
        assert!(closed.load(Ordering::SeqCst) >= 1);
    }

    #[test]
    fn the_hello_deadline_is_lifted_once_hello_is_answered() {
        let (_, api) = controller("");
        let lifted = Arc::new(AtomicUsize::new(0));
        let sink = Sink::default();
        let conn = Conn {
            on_hello: {
                let lifted = Arc::clone(&lifted);
                Box::new(move || {
                    lifted.fetch_add(1, Ordering::SeqCst);
                })
            },
            ..Conn::plain(
                std::io::Cursor::new(format!(
                    "{}\n{HELLO}\n{HELLO}\n",
                    r#"{"id":9,"m":"hello","p":{"api":2}}"#
                )),
                sink.clone(),
            )
        };
        serve_connection(api, conn);
        assert_eq!(
            lifted.load(Ordering::SeqCst),
            1,
            "a refused hello lifts nothing"
        );
    }

    #[test]
    fn bad_lines_are_answered_and_the_connection_goes_on() {
        let (_, api) = controller("");
        let out = talk(
            api,
            &[
                HELLO,
                "not json",
                "",
                r#"{"id":2,"m":"nope"}"#,
                r#"{"id":3,"m":"system.info","p":{"x":1}}"#,
                r#"{"id":4,"m":"claude.update"}"#,
                r#"{"id":5,"extra":1,"m":"system.info"}"#,
                r#"{"id":6,"m":"telemetry.get"}"#,
            ]
            .join("\n"),
        );
        assert_eq!(out[0]["id"], 1);
        assert_eq!(out[1]["err"]["code"], "unknown_method");
        assert_eq!(out[2]["err"]["code"], "bad_request");
        // Not offered on the controller: nix pins Claude there.
        assert_eq!(out[3]["err"]["code"], "unsupported");
        // An unknown field in the envelope is ignored (wire.rs).
        assert_eq!(out[4]["id"], 5);
        assert_eq!(out[4]["ok"]["api"], 1);
        assert_eq!(out[5]["ok"], json!({"level":"full","telemetry":null}));
        // "not json": no id to answer to.
        assert_eq!(out[6]["id"], Value::Null);
        assert_eq!(out[6]["err"]["code"], "bad_request");
    }

    #[test]
    fn claude_status_restart_and_the_changed_event() {
        let (shared, api) = controller("[controller]\nclaude_remote_control = true\n");
        // Nothing reported yet.
        let out = talk(
            Arc::clone(&api),
            &[HELLO, r#"{"id":2,"m":"claude.status"}"#].join("\n"),
        );
        assert_eq!(
            out[1]["ok"],
            json!({"reporting":false,"wanted":true,"report":null})
        );

        // A subscriber, a report, a restart asked, a new pid reported.
        let (reader, mut feed) = pipe();
        let sink = Sink::default();
        let conn = {
            let (api, sink) = (Arc::clone(&api), sink.clone());
            std::thread::spawn(move || serve_connection(api, Conn::plain(reader, sink)))
        };
        let send = |feed: &mut std::sync::mpsc::Sender<Vec<u8>>, l: &str| {
            feed.send(format!("{l}\n").into_bytes()).unwrap();
        };
        send(&mut feed, HELLO);
        send(&mut feed, r#"{"id":2,"m":"events.subscribe"}"#);
        wait_for(&sink, 2);
        let report = |pid| Report {
            state: "running".into(),
            pid: Some(pid),
            ..Default::default()
        };
        assert!(!shared.set_claude(report(10)).restart);
        // The same state and pid again is no event.
        shared.set_claude(report(10));
        send(&mut feed, r#"{"id":3,"m":"claude.restart"}"#);
        wait_for(&sink, 4);
        assert!(shared.claude_instruction_waiting());
        let answer = shared.set_claude(report(11));
        assert!(answer.restart, "the restart rides the next report, once");
        assert!(!shared.claude_instruction_waiting());
        send(&mut feed, r#"{"id":4,"m":"claude.status"}"#);
        wait_for(&sink, 6);
        drop(feed);
        conn.join().unwrap();

        let lines = sink.lines();
        let events: Vec<&Value> = lines.iter().filter(|l| l.get("e").is_some()).collect();
        assert_eq!(
            events,
            [
                &json!({"e":"claude.changed","p":{"reporting":true,"state":"running","pid":10}}),
                &json!({"e":"claude.changed","p":{"reporting":true,"state":"running","pid":11}}),
            ]
        );
        let by_id = |id: u64| lines.iter().find(|l| l["id"] == id).unwrap();
        assert_eq!(by_id(2)["ok"], json!({}));
        assert_eq!(by_id(3)["ok"], json!({"queued":true}));
        assert_eq!(by_id(4)["ok"]["report"]["pid"], 11);
        assert_eq!(by_id(4)["ok"]["reporting"], true);
    }

    #[test]
    fn a_restart_is_unavailable_while_no_session_reports() {
        let (shared, api) = controller("[controller]\nclaude_remote_control = true\n");
        let out = talk(api, &[HELLO, r#"{"id":2,"m":"claude.restart"}"#].join("\n"));
        assert_eq!(out[1]["err"]["code"], "unavailable");
        assert!(out[1]["err"]["msg"]
            .as_str()
            .unwrap()
            .contains("no session"));
        assert!(!shared.claude_instruction_waiting());
    }

    #[test]
    fn a_restart_is_unavailable_while_claude_is_off() {
        let (shared, api) = controller("");
        let out = talk(api, &[HELLO, r#"{"id":2,"m":"claude.restart"}"#].join("\n"));
        assert_eq!(out[1]["err"]["code"], "unavailable");
        assert!(!shared.claude_instruction_waiting());
    }

    #[test]
    fn telemetry_follows_the_level() {
        let (shared, api) = controller("telemetry = \"minimal\"\n");
        shared.set_telemetry(crate::telemetry::Telemetry {
            sampled_at: "t".into(),
            ..Default::default()
        });
        let out = talk(api, &[HELLO, r#"{"id":2,"m":"telemetry.get"}"#].join("\n"));
        assert_eq!(out[1]["ok"]["level"], "minimal");
        assert_eq!(out[1]["ok"]["telemetry"]["sampled_at"], "t");
        assert_eq!(
            out[0]["ok"]["capabilities"],
            json!(["claude.remote_control", "telemetry.minimal"])
        );

        let (shared, api) = controller("telemetry = \"off\"\n");
        shared.set_telemetry(crate::telemetry::Telemetry::default());
        let out = talk(api, &[HELLO, r#"{"id":2,"m":"telemetry.get"}"#].join("\n"));
        assert_eq!(out[1]["ok"], json!({"level":"off","telemetry":null}));
    }

    #[test]
    fn a_line_past_the_limit_closes_the_connection() {
        let (_, api) = controller("");
        let long = format!(
            "{HELLO}\n{}\n{}",
            "x".repeat(MAX_LINE + 10),
            r#"{"id":3,"m":"system.info"}"#
        );
        let out = talk(api, &long);
        assert_eq!(out.len(), 2, "{out:?}");
        assert_eq!(out[0]["id"], 1);
        assert_eq!(out[1]["err"]["code"], "too_large");
    }

    #[test]
    fn requests_run_concurrently() {
        let (_, api) = controller("");
        let mut input = vec![HELLO.to_string()];
        input.extend((2..=21).map(|i| format!(r#"{{"id":{i},"m":"system.info"}}"#)));
        let out = talk(api, &input.join("\n"));
        assert_eq!(out.len(), 21);
        assert!(out.iter().skip(1).all(|l| l["ok"]["api"] == 1));
    }

    /// The reading half of an in-memory pipe: what the sender sends, and
    /// the end once it is dropped.
    struct Feed {
        rx: std::sync::mpsc::Receiver<Vec<u8>>,
        buf: std::collections::VecDeque<u8>,
    }

    impl Read for Feed {
        fn read(&mut self, out: &mut [u8]) -> std::io::Result<usize> {
            if self.buf.is_empty() {
                match self.rx.recv() {
                    Ok(bytes) => self.buf.extend(bytes),
                    Err(_) => return Ok(0),
                }
            }
            let n = out.len().min(self.buf.len());
            for (o, b) in out.iter_mut().zip(self.buf.drain(..n)) {
                *o = b;
            }
            Ok(n)
        }
    }

    fn pipe() -> (Feed, std::sync::mpsc::Sender<Vec<u8>>) {
        let (tx, rx) = std::sync::mpsc::channel();
        (
            Feed {
                rx,
                buf: Default::default(),
            },
            tx,
        )
    }

    fn wait_for(sink: &Sink, lines: usize) {
        let until = Instant::now() + Duration::from_secs(5);
        while sink.lines().len() < lines {
            assert!(
                Instant::now() < until,
                "waited for {lines} lines: {:?}",
                sink.lines()
            );
            std::thread::sleep(Duration::from_millis(10));
        }
    }
}
