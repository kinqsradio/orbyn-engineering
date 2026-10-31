//! `orbynd`: transport and CLI over `orbyn-core`.

mod access;
mod api;
mod stream;
mod terminal_ws;
mod ui;

use std::net::{Ipv4Addr, SocketAddr};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::Duration;

use access::Access;
use api::AppState;
use axum::Router;
use axum::extract::DefaultBodyLimit;
use axum::middleware::from_fn_with_state;
use axum::routing::{get, post};
use clap::{Args, Parser, Subcommand};
use orbyn_core::engines::EngineConfig;
use orbyn_core::util::{random_token, sha256_hex};
use orbyn_core::{Core, CoreConfig, CoreError, skills};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

const BODY_LIMIT: usize = 4 * 1024 * 1024;
const REMOTE_KEY_SETTING: &str = "remote_key_sha256";
const SHUTDOWN_GRACE: Duration = Duration::from_secs(2);
const SANDBOX_MODES: &[&str] = &["read-only", "workspace-write", "danger-full-access"];

#[derive(Parser)]
#[command(name = "orbynd", version, about = "Orbyn Engineering core service")]
struct Cli {
    #[command(subcommand)]
    command: Command,
}

#[derive(Subcommand)]
enum Command {
    /// Serve the API and UI.
    Serve(ServeArgs),
}

#[derive(Args)]
struct ServeArgs {
    /// Port to bind; 0 picks a free one.
    #[arg(long, default_value_t = 0)]
    port: u16,
    #[arg(long)]
    data_dir: Option<PathBuf>,
    #[arg(long)]
    ui_dir: Option<PathBuf>,
    /// Skill library; also `ORBYN_SKILLS_DIR`.
    #[arg(long, env = "ORBYN_SKILLS_DIR")]
    skills_dir: Option<PathBuf>,
    /// Bind every interface. Requires `--tls-terminated`.
    #[arg(long)]
    remote: bool,
    /// Asserts that Tailscale, SSH or a proxy provides transport security.
    #[arg(long)]
    tls_terminated: bool,
    /// An extra accepted `Host` value. Repeatable.
    #[arg(long = "allowed-host")]
    allowed_hosts: Vec<String>,
    /// Exit when stdin closes, so a parent shell cannot orphan this service.
    #[arg(long)]
    parent_stdin: bool,
}

fn default_data_dir() -> Option<PathBuf> {
    let home = || {
        std::env::var_os("HOME")
            .or_else(|| std::env::var_os("USERPROFILE"))
            .map(PathBuf::from)
    };
    #[cfg(target_os = "macos")]
    let dir = home().map(|home| home.join("Library/Application Support/Orbyn"));
    #[cfg(windows)]
    let dir = std::env::var_os("LOCALAPPDATA")
        .map(PathBuf::from)
        .or_else(home)
        .map(|base| base.join("Orbyn"));
    #[cfg(not(any(target_os = "macos", windows)))]
    let dir = std::env::var_os("XDG_DATA_HOME")
        .map(PathBuf::from)
        .or_else(|| home().map(|home| home.join(".local/share")))
        .map(|base| base.join("orbyn"));
    dir
}

fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| value == "1" || value == "true")
}

fn core_config(args: &ServeArgs, base_url: String) -> Result<CoreConfig, String> {
    let data_dir = args
        .data_dir
        .clone()
        .or_else(default_data_dir)
        .ok_or("Set --data-dir: no app-data directory could be found.")?;
    let mut config = CoreConfig::new(data_dir, base_url);
    config.skills_dir = args.skills_dir.clone().or_else(skills::detect_source);
    let defaults = EngineConfig::default();
    let sandbox = std::env::var("ORBYN_CODEX_SANDBOX").unwrap_or(defaults.codex_sandbox);
    if !SANDBOX_MODES.contains(&sandbox.as_str()) {
        return Err(format!(
            "ORBYN_CODEX_SANDBOX must be one of {SANDBOX_MODES:?}."
        ));
    }
    config.engines = EngineConfig {
        claude_program: std::env::var("ORBYN_CLAUDE_BIN").unwrap_or(defaults.claude_program),
        codex_program: std::env::var("ORBYN_CODEX_BIN").unwrap_or(defaults.codex_program),
        codex_sandbox: sandbox,
        lookup_latest: !env_flag("ORBYN_OFFLINE"),
        update_timeout: defaults.update_timeout,
    };
    if let Ok(seconds) = std::env::var("ORBYN_APPROVAL_TIMEOUT_SECS") {
        let seconds: u64 = seconds
            .parse()
            .map_err(|_| "ORBYN_APPROVAL_TIMEOUT_SECS must be a number.".to_owned())?;
        config.approval_timeout = Duration::from_secs(seconds);
    }
    config.desktop_program = std::env::var("ORBYN_AGENT_DESKTOP").ok();
    config.browser_path = std::env::var_os("ORBYN_BROWSER").map(PathBuf::from);
    config.browser_headless = env_flag("ORBYN_BROWSER_HEADLESS");
    Ok(config)
}

fn router(state: AppState) -> Router {
    let access = state.access.clone();
    let protected = Router::new()
        .route("/api/info", get(api::info))
        .route(
            "/api/projects",
            get(api::list_projects).post(api::add_project),
        )
        .route("/api/projects/{id}/trust", post(api::trust_project))
        .route("/api/fs/browse", get(api::browse))
        .route(
            "/api/threads",
            get(api::list_threads).post(api::create_thread),
        )
        .route(
            "/api/threads/{id}",
            get(api::get_thread).delete(api::delete_thread),
        )
        .route("/api/threads/{id}/runs", post(api::start_run))
        .route("/api/runs/{id}/cancel", post(api::cancel_run))
        .route("/api/threads/{id}/events", get(stream::thread_events))
        .route("/api/approvals", get(api::list_approvals))
        .route("/api/approvals/{id}/decide", post(api::decide_approval))
        .route("/api/threads/{id}/diff", get(api::thread_diff))
        .route("/api/engines", get(api::list_engines))
        .route("/api/engines/refresh", post(api::refresh_engines))
        .route("/api/engines/custom", post(api::add_custom_engine))
        .route(
            "/api/engines/custom/{id}",
            axum::routing::delete(api::delete_custom_engine),
        )
        .route("/api/engines/{id}/update", post(api::update_engine))
        .route("/api/skills", get(api::skills))
        .route("/api/skills/rebuild", post(api::rebuild_skills))
        .route(
            "/api/skills/profiles",
            get(api::list_profiles).post(api::create_profile),
        )
        .route(
            "/api/skills/profiles/{id}",
            axum::routing::delete(api::delete_profile),
        )
        .route(
            "/api/policy/rules",
            get(api::list_rules).post(api::create_rule),
        )
        .route(
            "/api/policy/rules/{id}",
            axum::routing::delete(api::delete_rule),
        )
        .route("/api/audit", get(api::audit))
        .route("/api/computer", get(api::computer_status))
        .route("/api/threads/{id}/computer", post(api::computer_action))
        .route("/agui/threads/{id}", post(stream::agui_run))
        .route("/ws/terminal/{thread_id}", get(terminal_ws::terminal))
        .route_layer(from_fn_with_state(access.clone(), access::require_auth));
    Router::new()
        .merge(protected)
        .route("/auth/session", post(api::open_session))
        .route("/mcp/{thread_token}", post(api::mcp).get(api::mcp_get))
        .fallback(ui::serve)
        .layer(DefaultBodyLimit::max(BODY_LIMIT))
        .layer(from_fn_with_state(access, access::guard_origin))
        .with_state(state)
}

/// Returns the stored key digest, creating a key on first remote start. The key
/// itself is shown once and never stored.
fn remote_key(core: &Core) -> Result<(String, Option<String>), CoreError> {
    if let Some(digest) = core.store.setting(REMOTE_KEY_SETTING)? {
        return Ok((digest, None));
    }
    let key = random_token()?;
    let digest = sha256_hex(key.as_bytes());
    core.store.set_setting(REMOTE_KEY_SETTING, &digest)?;
    Ok((digest, Some(key)))
}

async fn wait_for_stop(parent_stdin: bool, stop: CancellationToken) {
    let parent = async {
        if parent_stdin {
            // A plain thread: tokio's stdin would hold the runtime open at exit.
            let (closed, wait) = oneshot::channel::<()>();
            std::thread::spawn(move || {
                let mut sink = [0u8; 256];
                let mut stdin = std::io::stdin().lock();
                while matches!(std::io::Read::read(&mut stdin, &mut sink), Ok(read) if read > 0) {}
                let _ = closed.send(());
            });
            let _ = wait.await;
        } else {
            std::future::pending::<()>().await;
        }
    };
    tokio::select! {
        () = parent => {}
        () = termination() => {}
    }
    stop.cancel();
}

#[cfg(unix)]
async fn termination() {
    use tokio::signal::unix::{SignalKind, signal};
    match signal(SignalKind::terminate()) {
        Ok(mut terminate) => {
            tokio::select! {
                _ = terminate.recv() => {}
                _ = tokio::signal::ctrl_c() => {}
            }
        }
        Err(_) => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}

#[cfg(windows)]
async fn termination() {
    let _ = tokio::signal::ctrl_c().await;
}

async fn serve(args: ServeArgs) -> Result<(), String> {
    if args.remote && !args.tls_terminated {
        return Err(
            "--remote needs --tls-terminated: confirm that Tailscale, SSH or a proxy secures the connection."
                .into(),
        );
    }
    let ip = if args.remote {
        Ipv4Addr::UNSPECIFIED
    } else {
        Ipv4Addr::LOCALHOST
    };
    let listener = TcpListener::bind(SocketAddr::from((ip, args.port)))
        .await
        .map_err(|error| format!("Could not bind port {}: {error}", args.port))?;
    let port = listener
        .local_addr()
        .map_err(|error| error.to_string())?
        .port();
    let base_url = format!("http://127.0.0.1:{port}");
    let core = Arc::new(
        Core::open(core_config(&args, base_url.clone())?).map_err(|error| error.to_string())?,
    );
    let token = random_token().map_err(|error| error.to_string())?;
    let (key_digest, new_key) = if args.remote {
        let (digest, key) = remote_key(&core).map_err(|error| error.to_string())?;
        (Some(digest), key)
    } else {
        (None, None)
    };
    let access = Arc::new(Access::new(&token, args.allowed_hosts.clone(), key_digest));
    let app = router(AppState {
        core: core.clone(),
        access,
        remote: args.remote,
        ui_dir: args.ui_dir.clone(),
    });

    let mut start = json!({ "url": base_url, "token": token });
    if let Some(key) = new_key {
        start["access_key"] = json!(key);
    }
    println!("{start}");

    let stop = CancellationToken::new();
    tokio::spawn(wait_for_stop(args.parent_stdin, stop.clone()));
    let shutdown = stop.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move { shutdown.cancelled().await })
            .await
    });
    stop.cancelled().await;
    tracing::info!("stopping");
    core.shutdown().await;
    // Open streams never finish on their own; they end with the process.
    let _ = tokio::time::timeout(SHUTDOWN_GRACE, server).await;
    Ok(())
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_env("ORBYN_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .with_writer(std::io::stderr)
        .init();
    let cli = Cli::parse();
    let outcome = match cli.command {
        Command::Serve(args) => serve(args).await,
    };
    match outcome {
        Ok(()) => std::process::ExitCode::SUCCESS,
        Err(message) => {
            eprintln!("{message}");
            std::process::ExitCode::FAILURE
        }
    }
}
