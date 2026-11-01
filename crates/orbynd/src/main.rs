//! `orbynd`: transport and CLI over `orbyn-core`.

mod access;
mod api;
mod preview_routes;
mod pulls;
mod raw_files;
mod recent_events;
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
use tracing_subscriber::filter::LevelFilter;
use tracing_subscriber::layer::SubscriberExt;
use tracing_subscriber::util::SubscriberInitExt;
use tracing_subscriber::{EnvFilter, Layer};

const BODY_LIMIT: usize = 4 * 1024 * 1024;
/// A little over the largest allowed file; core enforces the exact limits.
const UPLOAD_LIMIT: usize = 51 * 1024 * 1024;
const REMOTE_KEY_SETTING: &str = "remote_key_sha256";
/// Where the `orbyn` command finds this service.
const SERVICE_FILE: &str = "service.json";
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
    /// Where the clone that replaces the shipped snapshot comes from.
    #[arg(long, env = "ORBYN_WORKSPACE_URL")]
    workspace_url: Option<String>,
    /// The folder holding the library snapshot that ships with the app.
    #[arg(long, env = "ORBYN_LIBRARY_BUNDLE")]
    library_bundle: Option<PathBuf>,
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

fn env_flag(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| value == "1" || value == "true")
}

fn known_engine_ids(raw: Option<&std::ffi::OsStr>) -> Result<Option<Vec<String>>, String> {
    raw.map(|value| {
        let value = value
            .to_str()
            .ok_or_else(|| "ORBYN_KNOWN_ENGINE_IDS must be UTF-8 JSON.".to_owned())?;
        serde_json::from_str(value)
            .map_err(|_| "ORBYN_KNOWN_ENGINE_IDS must be a JSON array of strings.".to_owned())
    })
    .transpose()
}

fn core_config(args: &ServeArgs, base_url: String) -> Result<CoreConfig, String> {
    let data_dir = args
        .data_dir
        .clone()
        .or_else(orbyn_core::app::default_data_dir)
        .ok_or("Set --data-dir: no app-data directory could be found.")?;
    let mut config = CoreConfig::new(data_dir, base_url);
    if args.skills_dir.is_some() {
        tracing::warn!("--skills-dir is ignored: skills come from the managed workspace");
    }
    config.update_manifest.clone_from(&args.update_manifest);
    if let Some(url) = &args.workspace_url {
        config.workspace_url.clone_from(url);
    }
    config.library_bundle.clone_from(&args.library_bundle);
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
        known_engine_ids: known_engine_ids(std::env::var_os("ORBYN_KNOWN_ENGINE_IDS").as_deref())?,
    };
    if let Ok(seconds) = std::env::var("ORBYN_APPROVAL_TIMEOUT_SECS") {
        let seconds: u64 = seconds
            .parse()
            .map_err(|_| "ORBYN_APPROVAL_TIMEOUT_SECS must be a number.".to_owned())?;
        config.approval_timeout = Duration::from_secs(seconds);
    }
    config.desktop_program = std::env::var("ORBYN_AGENT_DESKTOP").ok();
    config.browser_path = std::env::var_os("ORBYN_BROWSER").map(PathBuf::from);
    if let Ok(url) = std::env::var("ORBYN_ACP_REGISTRY_URL") {
        config.acp_registry_url = url;
    }
    config.browser_headless = env_flag("ORBYN_BROWSER_HEADLESS");
    config.browser_in_process_gpu = env_flag("ORBYN_BROWSER_IN_PROCESS_GPU");
    Ok(config)
}

fn router(state: AppState) -> Router {
    let access = state.access.clone();
    let protected = Router::new()
        .route("/api/info", get(api::info))
        .route("/api/projects", get(api::list_projects))
        .route("/api/projects/clone", post(api::clone_project))
        .route("/api/projects/create", post(api::create_project))
        .route("/api/clones", get(api::list_clones).post(api::start_clone))
        .route("/api/clones/{id}/cancel", post(api::cancel_clone))
        .route("/api/clones/{id}/retry", post(api::retry_clone))
        .route("/api/projects/add", post(api::add_project))
        .route("/api/threads/{id}/project", post(api::move_thread))
        .route("/api/threads/{id}/adopt", post(api::adopt_scratch))
        .route(
            "/api/projects/{id}",
            axum::routing::patch(api::rename_project).delete(api::remove_project),
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
        .route("/api/shell", get(api::shell_status))
        .route("/api/shell/events", get(stream::shell_events))
        .route("/api/shell/actions", post(api::shell_action))
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
        .route("/api/threads/{id}/messages", get(api::thread_messages))
        .route(
            "/api/threads/{id}/runs/{run}/changes",
            get(api::run_changes),
        )
        .route(
            "/api/threads/{id}/runs/{run}/changes/file",
            get(api::changed_file),
        )
        .route(
            "/api/threads/{id}/runs/{run}/changes/restore",
            post(api::restore_changes),
        )
        .route("/api/network", get(api::network_requests))
        .route("/api/threads/{id}/items/{item}", get(api::get_item))
        .route("/api/threads/{id}/usage", get(api::thread_usage))
        .route("/api/threads/{id}/files", get(api::file_tree))
        .route("/api/threads/{id}/files/ignored", get(api::ignored_files))
        .route(
            "/api/threads/{id}/paths/resolve",
            post(api::resolve_thread_path),
        )
        .route("/api/threads/{id}/files/search", get(api::search_files))
        .route(
            "/api/threads/{id}/files/content",
            get(api::read_file).put(api::write_file),
        )
        .route("/api/threads/{id}/files/raw", get(raw_files::serve))
        .route("/api/threads/{id}/files/open", post(api::open_in_editor))
        .route("/api/editors", get(api::editors))
        .route("/api/threads/{id}/commits", get(api::commits))
        .route("/api/threads/{id}/checkpoints", get(api::checkpoints))
        .route("/api/threads/{id}/restore", post(api::restore_workspace))
        .route("/api/threads/{id}/rewind", post(api::rewind_thread))
        .route("/api/threads/{id}/fork", post(api::fork_thread))
        .route("/api/threads/{id}/bring-back", post(api::bring_back))
        .route(
            "/api/threads/{id}/restart-session",
            post(api::restart_session),
        )
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
        .route("/api/forges", get(pulls::forges))
        .route("/api/pulls", get(pulls::all))
        .route("/api/projects/{id}/pulls", get(pulls::list))
        .route("/api/projects/{id}/pulls/close", post(pulls::close_many))
        .route(
            "/api/projects/{id}/pulls/reviewers",
            get(pulls::reviewer_candidates),
        )
        .route(
            "/api/projects/{id}/pulls/labels",
            get(pulls::label_candidates),
        )
        .route(
            "/api/projects/{id}/workflows/{run}/approve",
            post(pulls::approve_workflow),
        )
        .route(
            "/api/projects/{id}/pulls/{number}",
            get(pulls::detail).patch(pulls::update),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/checks",
            get(pulls::checks),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/comments",
            get(pulls::conversation).post(pulls::comment),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/comments/{comment}",
            axum::routing::patch(pulls::edit_comment),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/comments/{comment}/react",
            post(pulls::react),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/threads/{thread}/resolve",
            post(pulls::resolve_thread),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/timeline",
            get(pulls::timeline),
        )
        .route("/api/projects/{id}/pulls/{number}/files", get(pulls::files))
        .route(
            "/api/projects/{id}/pulls/{number}/revisions",
            get(pulls::revisions),
        )
        .route(
            "/api/projects/{id}/commits/{sha}/files",
            get(pulls::revision_files),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/viewed",
            post(pulls::set_viewed),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/review",
            post(pulls::review),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/reviewers",
            post(pulls::set_reviewers),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/labels",
            post(pulls::set_labels),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/merge",
            post(pulls::merge),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/action",
            post(pulls::action),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/stack",
            get(pulls::stack).post(pulls::stack_action),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/checkout",
            post(pulls::checkout),
        )
        .route(
            "/api/projects/{id}/pulls/{number}/work",
            post(pulls::work_on),
        )
        .route("/api/threads/{id}/watches", get(pulls::watches))
        .route("/api/watches/check", post(pulls::check_watches))
        .route(
            "/api/threads/{id}/pulls/{number}/watch",
            post(pulls::watch).delete(pulls::unwatch),
        )
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
        .route("/api/projects/{id}/icon", get(api::project_icon))
        .route("/api/settings/project-scopes", post(api::project_scopes))
        .route(
            "/api/settings/projects/rename",
            post(api::rename_selected_projects),
        )
        .route(
            "/api/source-control/repository-star",
            get(api::repository_star_status),
        )
        .route(
            "/api/settings/preferences/query",
            post(api::scoped_preferences),
        )
        .route(
            "/api/settings/preferences",
            axum::routing::put(api::change_scoped_preferences),
        )
        .route(
            "/api/preferences",
            get(api::preferences).put(api::set_preferences),
        )
        .route(
            "/api/projects/{id}/preferences",
            axum::routing::put(api::set_project_preferences),
        )
        .route("/api/projects/{id}/pull", post(api::pull_project))
        .route(
            "/api/keybindings",
            get(api::keybindings).post(api::save_keybinding),
        )
        .route("/api/diagnostics", get(api::diagnostics))
        .route("/api/diagnostics/repair", post(api::repair_database))
        .route(
            "/api/diagnostics/processes/{pid}/stop",
            post(api::stop_process),
        )
        .route("/api/diagnostics/otlp", post(api::check_otlp))
        .route(
            "/api/storage/cleanup",
            get(api::cleanup_report).post(api::storage_cleanup),
        )
        .route("/api/tasks", get(api::tasks).post(api::save_task))
        .route(
            "/api/tasks/{id}",
            axum::routing::put(api::update_task).delete(api::delete_task),
        )
        .route("/api/tasks/{id}/enabled", post(api::set_task_enabled))
        .route("/api/tasks/{id}/run", post(api::run_task))
        .route("/api/tasks/{id}/webhook", post(api::rotate_webhook))
        .route("/api/tasks/{id}/deliveries", get(api::task_deliveries))
        .route("/api/threads/{id}/delegate", post(api::delegate))
        .route("/api/threads/batch", post(api::batch_threads))
        .route(
            "/api/threads/{id}/previews",
            get(preview_routes::list).post(preview_routes::open),
        )
        .route(
            "/api/threads/{id}/previews/{tab}",
            axum::routing::delete(preview_routes::close),
        )
        .route(
            "/api/threads/{id}/previews/file",
            post(preview_routes::open_file),
        )
        .route(
            "/api/threads/{id}/previews/{tab}/view",
            post(preview_routes::view),
        )
        .route(
            "/api/threads/{id}/previews/{tab}/reload",
            post(preview_routes::reload),
        )
        .route(
            "/api/threads/{id}/previews/{tab}/clear",
            post(preview_routes::clear),
        )
        .route(
            "/api/threads/{id}/previews/{tab}/pick",
            post(preview_routes::pick),
        )
        .route(
            "/api/browser-profiles",
            get(preview_routes::profiles).post(preview_routes::create_profile),
        )
        .route(
            "/api/browser-profiles/{id}",
            axum::routing::delete(preview_routes::delete_profile),
        )
        .route(
            "/api/browser-profiles/{id}/clear",
            post(preview_routes::clear_profile),
        )
        .route(
            "/api/threads/{id}/previews/{tab}/navigate",
            post(preview_routes::navigate),
        )
        .route(
            "/api/threads/{id}/previews/{tab}/history",
            post(preview_routes::history),
        )
        .route(
            "/api/threads/{id}/previews/{tab}/resize",
            post(preview_routes::resize),
        )
        .route(
            "/api/threads/{id}/previews/{tab}/control",
            post(preview_routes::control),
        )
        .route(
            "/api/threads/{id}/previews/{tab}/input",
            post(preview_routes::input),
        )
        .route(
            "/api/threads/{id}/previews/{tab}/recording",
            post(preview_routes::start_recording).delete(preview_routes::stop_recording),
        )
        .route("/ws/preview/{id}/{tab}", get(preview_routes::stream))
        .route("/api/threads/{id}/servers", get(preview_routes::servers))
        .route(
            "/api/threads/{id}/servers/{pid}/stop",
            post(preview_routes::stop_server),
        )
        .route("/api/threads/{id}/runs", post(api::start_run))
        .route("/api/threads/{id}/preparation", get(api::preparation_retry))
        .route(
            "/api/threads/{id}/preparation/retry",
            post(api::retry_preparation),
        )
        .route("/api/runs/{id}/cancel", post(api::cancel_run))
        .route("/api/threads/{id}/force-stop", post(api::force_stop))
        .route("/api/search/messages", get(api::search_messages))
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
        .route("/api/acp/registry", get(api::search_acp_registry))
        .route(
            "/api/acp/registry/{id}",
            post(api::install_acp_agent).delete(api::remove_acp_agent),
        )
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
        .route(
            "/ws/terminal/{thread_id}/{terminal}",
            get(terminal_ws::attach),
        )
        .route(
            "/api/threads/{id}/terminals",
            get(terminal_ws::list).post(terminal_ws::open),
        )
        .route(
            "/api/threads/{id}/terminals/{terminal}",
            axum::routing::patch(terminal_ws::rename).delete(terminal_ws::close),
        )
        .route(
            "/api/threads/{id}/terminals/{terminal}/scrollback",
            get(terminal_ws::scrollback).delete(terminal_ws::clear),
        )
        .route(
            "/api/threads/{id}/scripts",
            get(terminal_ws::scripts).post(terminal_ws::run_script),
        )
        .route_layer(from_fn_with_state(state.clone(), api::note_activity))
        .route_layer(from_fn_with_state(access.clone(), access::require_auth));
    Router::new()
        .merge(protected)
        .route("/auth/session", post(api::open_session))
        .route("/hooks/{id}/{token}", post(api::webhook))
        .route(
            "/mcp/{thread_token}",
            post(api::mcp)
                .get(api::mcp_get)
                .layer(DefaultBodyLimit::max(orbyn_core::mcp::MAX_REQUEST_BYTES)),
        )
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
                Ok(line) => {
                    if !core.shell.on_line(&line) {
                        core.updates.on_shell_line(&line);
                    }
                }
                // Not UTF-8 is a bad line, not a closed pipe.
                Err(error) if error.kind() == std::io::ErrorKind::InvalidData => {}
                Err(_) => break,
            }
        }
        let _ = closed.send(());
    });
}

async fn wait_for_stop(
    parent: Option<oneshot::Receiver<()>>,
    stop: CancellationToken,
    termination: impl std::future::Future<Output = ()> + Send,
) {
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
        () = termination => {}
    }
    stop.cancel();
}

#[cfg(unix)]
fn termination() -> Result<impl std::future::Future<Output = ()> + Send, String> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut terminate = signal(SignalKind::terminate())
        .map_err(|error| format!("Could not listen for termination: {error}"))?;
    let mut interrupt = signal(SignalKind::interrupt())
        .map_err(|error| format!("Could not listen for interrupts: {error}"))?;
    Ok(async move {
        tokio::select! {
            _ = terminate.recv() => {}
            _ = interrupt.recv() => {}
        }
    })
}

#[cfg(windows)]
fn termination() -> Result<impl std::future::Future<Output = ()> + Send, String> {
    let mut interrupt = tokio::signal::windows::ctrl_c()
        .map_err(|error| format!("Could not listen for interrupts: {error}"))?;
    Ok(async move {
        let _ = interrupt.recv().await;
    })
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
    core.mcp.bind_host(&core);
    orbyn_core::diagnostics::start_sampling();
    // Parent EOF and termination own startup too: provisioning may be waiting
    // on a helper before any ready line or service handle exists.
    // Install handlers synchronously before any cancellable provisioning work.
    let termination = termination()?;
    let stop = CancellationToken::new();
    let parent = args.parent_stdin.then(|| {
        let (closed, wait) = oneshot::channel();
        read_parent(core.clone(), closed);
        wait
    });
    tokio::spawn(wait_for_stop(parent, stop.clone(), termination));
    // Before the service answers anything. If the disk refuses, the background
    // attempt tries again, and the service still serves what needs no library.
    let library = tokio::select! {
        biased;
        () = stop.cancelled() => {
            // Dropping provision first releases its staging and helper owners.
            core.shutdown().await;
            return Ok(());
        }
        result = core.workspace.provision() => result.and_then(|()| core.ensure_library_project()),
    };
    if let Err(error) = library {
        tracing::error!("the skills library is not in place: {error}");
    }
    if stop.is_cancelled() {
        core.shutdown().await;
        return Ok(());
    }
    let token = random_token().map_err(|error| error.to_string())?;
    let (key_digest, new_key) = if args.remote {
        let (digest, key) = remote_key(&core).map_err(|error| error.to_string())?;
        (Some(digest), key)
    } else {
        (None, None)
    };
    let access = Arc::new(
        Access::new(&token, args.allowed_hosts.clone(), key_digest).with_desktop(args.parent_stdin),
    );
    let app = router(AppState {
        core: core.clone(),
        access,
        remote: args.remote,
        ui_dir: args.ui_dir.clone(),
    });

    // Attach before readiness so the early parent reader cannot drop a reply
    // sent immediately after the shell receives the ready line. Forward later,
    // keeping readiness first on stdout.
    let shell_lines = args.parent_stdin.then(|| {
        let lines = core.updates.attach_shell();
        if let Some(sender) = core.updates.shell_lines() {
            core.shell.attach(sender);
        }
        lines
    });
    let mut start = json!({ "url": base_url, "token": token });
    if let Some(key) = new_key {
        start["access_key"] = json!(key);
    }
    let handle = core.config.data_dir.join(SERVICE_FILE);
    let found = json!({ "url": base_url, "token": token, "pid": std::process::id() });
    if let Err(error) =
        orbyn_core::util::write_private_atomic(&handle, found.to_string().as_bytes())
    {
        tracing::warn!(%error, "the orbyn command will not find this service");
    }
    println!("{start}");

    if let Some(mut lines) = shell_lines {
        // Every line after the first ready line is for the shell.
        tokio::spawn(async move {
            while let Some(line) = lines.recv().await {
                println!("{line}");
            }
        });
    }
    let library_upgrades = {
        let (core, stop) = (core.clone(), stop.clone());
        tokio::spawn(async move { core.run_library_upgrades(stop).await })
    };
    let checks = {
        let (updates, stop) = (core.updates.clone(), stop.clone());
        tokio::spawn(async move { updates.run_checks(stop).await })
    };
    let lifecycle = {
        let (core, stop) = (core.clone(), stop.clone());
        tokio::spawn(async move { core.run_lifecycle(stop).await })
    };
    if args.parent_stdin {
        let (core, stop) = (core.clone(), stop.clone());
        tokio::spawn(async move { core.run_shell_activity(stop).await });
    }
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
    let _ = checks.await;
    let _ = library_upgrades.await;
    core.shutdown().await;
    let _ = std::fs::remove_file(handle);
    // Open streams never finish on their own; they end with the process.
    let _ = tokio::time::timeout(SHUTDOWN_GRACE, server).await;
    Ok(())
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::fmt::layer()
                .with_writer(std::io::stderr)
                .with_filter(
                    EnvFilter::try_from_env("ORBYN_LOG").unwrap_or_else(|_| EnvFilter::new("info")),
                ),
        )
        .with(recent_events::RecentEvents.with_filter(LevelFilter::WARN))
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

#[cfg(test)]
mod known_engine_config_tests {
    use super::known_engine_ids;
    #[test]
    fn known_discovery_config_is_optional_and_rejects_invalid_json() {
        assert_eq!(known_engine_ids(None).unwrap(), None);
        assert_eq!(
            known_engine_ids(Some(std::ffi::OsStr::new("[]"))).unwrap(),
            Some(Vec::new())
        );
        assert_eq!(
            known_engine_ids(Some(std::ffi::OsStr::new(r#"["opencode"]"#))).unwrap(),
            Some(vec!["opencode".into()])
        );
        for value in ["", "broken", "null", "{}", "[1]", r#""opencode""#] {
            assert!(
                known_engine_ids(Some(std::ffi::OsStr::new(value))).is_err(),
                "{value}"
            );
        }
    }
}
