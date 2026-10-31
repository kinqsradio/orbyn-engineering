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
use orbyn_core::{Core, CoreConfig, CoreError};
use serde_json::json;
use tokio::net::TcpListener;
use tokio::sync::oneshot;
use tokio_util::sync::CancellationToken;
use tracing_subscriber::EnvFilter;

const BODY_LIMIT: usize = 4 * 1024 * 1024;
/// A little over the largest allowed file; core enforces the exact limits.
const UPLOAD_LIMIT: usize = 51 * 1024 * 1024;
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
    /// Replaced by the managed workspace. Accepted and ignored so older shells
    /// that still pass it keep starting.
    #[arg(long, hide = true)]
    skills_dir: Option<PathBuf>,
    /// Release manifest to compare against when no desktop shell is attached.
    #[arg(long, env = "ORBYN_UPDATE_MANIFEST")]
    update_manifest: Option<String>,
    /// Where a first-run clone of the skills library comes from.
    #[arg(long, env = "ORBYN_WORKSPACE_URL")]
    workspace_url: Option<String>,
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
    if args.skills_dir.is_some() {
        tracing::warn!("--skills-dir is ignored: skills come from the managed workspace");
    }
    config.update_manifest.clone_from(&args.update_manifest);
    if let Some(url) = &args.workspace_url {
        config.workspace_url.clone_from(url);
    }
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
        .route("/api/projects", get(api::list_projects))
        .route("/api/projects/clone", post(api::clone_project))
        .route("/api/projects/create", post(api::create_project))
        .route("/api/projects/import", post(api::import_project))
        .route(
            "/api/projects/{id}",
            axum::routing::delete(api::remove_project),
        )
        .route("/api/workspace", get(api::workspace_status))
        .route("/api/workspace/setup", post(api::workspace_setup))
        .route("/api/workspace/update", post(api::workspace_update))
        .route("/api/workspace/rollback", post(api::workspace_rollback))
        .route("/api/projects/{id}/trust", post(api::trust_project))
        .route("/api/fs/browse", get(api::browse))
        .route(
            "/api/threads",
            get(api::list_threads).post(api::create_thread),
        )
        .route(
            "/api/threads/{id}",
            get(api::get_thread)
                .patch(api::update_thread)
                .delete(api::delete_thread),
        )
        .route("/api/updates", get(api::updates))
        .route("/api/updates/events", get(stream::update_events))
        .route("/api/updates/check", post(api::check_updates))
        .route("/api/updates/app/apply", post(api::apply_app_update))
        .route("/api/updates/apply-all", post(api::apply_all_updates))
        .route(
            "/api/threads/{id}/queue",
            get(api::list_queue).post(api::enqueue),
        )
        .route("/api/threads/{id}/queue/resume", post(api::resume_queue))
        .route(
            "/api/queue/{id}",
            axum::routing::patch(api::edit_queued).delete(api::remove_queued),
        )
        .route("/api/queue/{id}/send-now", post(api::send_queued_now))
        .route("/api/threads/{id}/steer", post(api::steer))
        .route(
            "/api/threads/{id}/attachments",
            get(api::list_attachments)
                .post(api::upload_attachment)
                .layer(DefaultBodyLimit::max(UPLOAD_LIMIT)),
        )
        .route(
            "/api/attachments/{id}",
            axum::routing::delete(api::remove_attachment),
        )
        .route("/api/threads/{id}/mentions", get(api::mentions))
        .route("/api/threads/{id}/commands", get(api::slash_commands))
        .route("/api/threads/{id}/items", get(api::list_items))
        .route("/api/threads/{id}/items/{item}", get(api::get_item))
        .route("/api/threads/{id}/usage", get(api::thread_usage))
        .route("/api/threads/{id}/files", get(api::file_tree))
        .route("/api/threads/{id}/files/ignored", get(api::ignored_files))
        .route("/api/threads/{id}/files/search", get(api::search_files))
        .route(
            "/api/threads/{id}/files/content",
            get(api::read_file).put(api::write_file),
        )
        .route("/api/threads/{id}/files/open", post(api::open_in_editor))
        .route("/api/editors", get(api::editors))
        .route("/api/threads/{id}/commits", get(api::commits))
        .route("/api/threads/{id}/checkpoints", get(api::checkpoints))
        .route("/api/threads/{id}/restore", post(api::restore_workspace))
        .route("/api/threads/{id}/rewind", post(api::rewind_thread))
        .route("/api/threads/{id}/fork", post(api::fork_thread))
        .route("/api/threads/{id}/switch-engine", post(api::switch_engine))
        .route("/api/threads/{id}/git/action", post(api::git_action))
        .route(
            "/api/threads/{id}/branches",
            get(api::branches).post(api::create_branch),
        )
        .route(
            "/api/threads/{id}/branches/switch",
            post(api::switch_branch),
        )
        .route(
            "/api/threads/{id}/pulls",
            get(api::linked_pulls).post(api::link_pull),
        )
        .route("/api/threads/{id}/pulls/refresh", post(api::refresh_pulls))
        .route(
            "/api/threads/{id}/pulls/{number}",
            get(api::pull_detail).delete(api::unlink_pull),
        )
        .route(
            "/api/threads/{id}/pulls/{number}/review",
            post(api::review_pull),
        )
        .route(
            "/api/threads/{id}/pulls/{number}/merge",
            post(api::merge_pull),
        )
        .route("/api/projects/{id}/pulls", get(api::project_pulls))
        .route("/api/projects/{id}/publish", post(api::publish_project))
        .route("/api/usage", get(api::usage).post(api::usage))
        .route("/api/usage/refresh", post(api::refresh_usage))
        .route("/api/limits", get(api::limits_overview))
        .route("/api/threads/{id}/limits", get(api::thread_limits))
        .route("/api/engines/{id}/limits", get(api::engine_limits))
        .route("/api/engines/{id}/models", get(api::engine_models))
        .route("/api/threads/order", post(api::reorder_threads))
        .route("/api/threads/{id}/title", post(api::regenerate_title))
        .route(
            "/api/settings",
            get(api::get_settings).put(api::put_settings),
        )
        .route("/api/threads/{id}/runs", post(api::start_run))
        .route("/api/runs/{id}/cancel", post(api::cancel_run))
        .route("/api/threads/{id}/events", get(stream::thread_events))
        .route("/api/approvals", get(api::list_approvals))
        .route("/api/approvals/{id}/decide", post(api::decide_approval))
        .route("/api/questions", get(api::list_questions))
        .route("/api/questions/{id}/answer", post(api::answer_question))
        .route("/api/questions/{id}/dismiss", post(api::dismiss_question))
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
        .route("/api/skills/rebuild", post(api::skills))
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

/// Reads newline JSON from the desktop shell. EOF means the shell is gone.
fn read_parent(core: Arc<Core>, closed: oneshot::Sender<()>) {
    use std::io::BufRead;
    // A plain thread: tokio's stdin would hold the runtime open at exit.
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines() {
            match line {
                Ok(line) => core.updates.on_shell_line(&line),
                // Not UTF-8 is a bad line, not a closed pipe.
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {}
                Err(_) => break,
            }
        }
        let _ = closed.send(());
    });
}

async fn wait_for_stop(parent: Option<oneshot::Receiver<()>>, stop: CancellationToken) {
    let parent = async {
        match parent {
            Some(closed) => {
                let _ = closed.await;
            }
            None => std::future::pending::<()>().await,
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
    let parent = args.parent_stdin.then(|| {
        let mut lines = core.updates.attach_shell();
        // Every line after the first ready line is for the shell.
        tokio::spawn(async move {
            while let Some(line) = lines.recv().await {
                println!("{line}");
            }
        });
        let (closed, wait) = oneshot::channel();
        read_parent(core.clone(), closed);
        wait
    });
    tokio::spawn(wait_for_stop(parent, stop.clone()));
    let checks = {
        let (updates, stop) = (core.updates.clone(), stop.clone());
        tokio::spawn(async move { updates.run_checks(stop).await })
    };
    let lifecycle = {
        let (core, stop) = (core.clone(), stop.clone());
        tokio::spawn(async move { core.run_lifecycle(stop).await })
    };
    let shutdown = stop.clone();
    let server = tokio::spawn(async move {
        axum::serve(listener, app)
            .with_graceful_shutdown(async move { shutdown.cancelled().await })
            .await
    });
    stop.cancelled().await;
    tracing::info!("stopping");
    let _ = lifecycle.await;
    checks.abort();
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
