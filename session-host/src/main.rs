//! `daedalus-session-host`: `serve` (the unit), `hook` (what agents' hooks
//! run) and `--version`. See README.md.

use std::path::Path;

use daedalus_session_host::{hook, logger, Config, Server, VERSION};
use santree_remote_proto::PROTOCOL_VERSION;
use tokio::signal::unix::{signal, SignalKind};

const USAGE: &str = "usage:
  daedalus-session-host --version
  daedalus-session-host serve --config FILE
  daedalus-session-host hook [--socket PATH] <event args…>";

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    std::process::exit(match args.first().map(String::as_str) {
        Some("--version") if args.len() == 1 => {
            println!("daedalus-session-host {VERSION} protocol {PROTOCOL_VERSION}");
            0
        }
        Some("--help") | Some("help") => {
            println!("{USAGE}");
            0
        }
        // No logger: `hook` must never write to stdout or stderr.
        Some("hook") => hook::run(&args[1..]),
        Some("serve") => match &args[1..] {
            [flag, file] if flag == "--config" => {
                logger::install();
                serve(Path::new(file))
            }
            _ => usage_error("serve takes --config FILE"),
        },
        _ => usage_error("expected a subcommand"),
    });
}

fn usage_error(why: &str) -> i32 {
    eprintln!("daedalus-session-host: {why}\n{USAGE}");
    2
}

fn serve(file: &Path) -> i32 {
    let config = match Config::load(file) {
        Ok(config) => config,
        Err(e) => {
            log::error!("{e}");
            return 1;
        }
    };
    let runtime = match tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()
    {
        Ok(runtime) => runtime,
        Err(e) => {
            log::error!("starting the runtime: {e}");
            return 1;
        }
    };
    runtime.block_on(async {
        let (mut term, mut int) = match (
            signal(SignalKind::terminate()),
            signal(SignalKind::interrupt()),
        ) {
            (Ok(term), Ok(int)) => (term, int),
            (Err(e), _) | (_, Err(e)) => {
                log::error!("installing signal handlers: {e}");
                return 1;
            }
        };
        let server = match Server::bind(config).await {
            Ok(server) => server,
            Err(e) => {
                log::error!("{e}");
                return 1;
            }
        };
        server
            .run(async {
                tokio::select! {
                    _ = term.recv() => log::info!("SIGTERM: stopping"),
                    _ = int.recv() => log::info!("SIGINT: stopping"),
                }
            })
            .await;
        0
    })
}
