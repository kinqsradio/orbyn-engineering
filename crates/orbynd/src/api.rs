//! The HTTP API from docs/architecture.md. Handlers parse, call core and map the
//! result; all product rules live in `orbyn-core`.

use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::Json;
use axum::extract::{FromRequest, Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use orbyn_contracts::{
    ApiError, ApprovalState, ComputerAction, CreatePolicyRule, CreateProject, CreateThread,
    CustomEngine, DecideApproval, EngineTier, FsEntry, FsListing, ReorderThreads, ServerInfo,
    ServerSettings, SkillProfile, StartRun, UpdateThread,
};
use orbyn_core::computer::Caller;
use orbyn_core::skills::DEFAULT_PROFILE;
use orbyn_core::util::new_id;
use orbyn_core::{Core, CoreError};
use serde::Deserialize;
use serde_json::{Value, json};

use crate::access::Access;

/// The actor recorded for anything arriving over the local API.
pub const LOCAL_USER: &str = "user";

#[derive(Clone)]
pub struct AppState {
    pub core: Arc<Core>,
    pub access: Arc<Access>,
    pub remote: bool,
    pub ui_dir: Option<PathBuf>,
}

pub struct ApiFailure {
    status: StatusCode,
    body: ApiError,
}

impl ApiFailure {
    pub fn forbidden(code: &str, message: &str) -> Self {
        Self::new(StatusCode::FORBIDDEN, code, message)
    }

    pub fn unauthorized() -> Self {
        Self::new(
            StatusCode::UNAUTHORIZED,
            "unauthorized",
            "Sign in to use this service.",
        )
    }

    pub fn new(status: StatusCode, code: &str, message: &str) -> Self {
        Self {
            status,
            body: ApiError {
                code: code.to_owned(),
                message: message.to_owned(),
                detail: None,
            },
        }
    }
}

impl From<CoreError> for ApiFailure {
    fn from(error: CoreError) -> Self {
        let status =
            StatusCode::from_u16(error.status()).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
        if status.is_server_error() {
            tracing::error!(%error, "request failed");
        }
        let detail = match &error {
            CoreError::AlreadyDecided(existing) => serde_json::to_value(existing).ok(),
            _ => None,
        };
        Self {
            status,
            body: ApiError {
                code: error.code().to_owned(),
                message: error.public_message(),
                detail,
            },
        }
    }
}

impl IntoResponse for ApiFailure {
    fn into_response(self) -> Response {
        (self.status, Json(self.body)).into_response()
    }
}

pub type ApiResult<T> = Result<T, ApiFailure>;

/// A JSON body whose rejection is an `ApiError`, so every failure has a code.
pub struct ApiJson<T>(pub T);

impl<S, T> FromRequest<S> for ApiJson<T>
where
    S: Send + Sync,
    Json<T>: FromRequest<S, Rejection = axum::extract::rejection::JsonRejection>,
{
    type Rejection = ApiFailure;

    async fn from_request(request: Request, state: &S) -> Result<Self, ApiFailure> {
        match Json::<T>::from_request(request, state).await {
            Ok(Json(value)) => Ok(Self(value)),
            Err(rejection) => Err(ApiFailure::new(
                StatusCode::BAD_REQUEST,
                "invalid_input",
                &rejection.body_text(),
            )),
        }
    }
}

pub async fn info(State(state): State<AppState>) -> Json<ServerInfo> {
    Json(ServerInfo {
        version: env!("CARGO_PKG_VERSION").to_owned(),
        remote: state.remote,
        platform: std::env::consts::OS.to_owned(),
    })
}

pub async fn list_projects(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.store.list_projects()?))
}

pub async fn add_project(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateProject>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(state.core.add_project(&body.path)?),
    ))
}

pub async fn trust_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.store.trust_project(&id, LOCAL_USER)?))
}

#[derive(Deserialize)]
pub struct BrowseQuery {
    path: Option<String>,
}

fn home() -> Option<PathBuf> {
    std::env::var_os("HOME")
        .or_else(|| std::env::var_os("USERPROFILE"))
        .map(PathBuf::from)
}

pub async fn browse(Query(query): Query<BrowseQuery>) -> ApiResult<Json<FsListing>> {
    let requested = query
        .path
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .or_else(home)
        .ok_or_else(|| CoreError::Invalid("Choose a folder.".into()))?;
    if !requested.is_absolute() {
        return Err(CoreError::Invalid("Choose an absolute folder path.".into()).into());
    }
    let path = orbyn_core::util::canonicalize(&requested)
        .map_err(|_| CoreError::Invalid(format!("{} cannot be opened.", requested.display())))?;
    let reader = std::fs::read_dir(&path)
        .map_err(|_| CoreError::Invalid(format!("{} cannot be read.", path.display())))?;
    let mut entries: Vec<FsEntry> = reader
        .filter_map(Result::ok)
        .filter(|entry| !entry.file_name().to_string_lossy().starts_with('.'))
        .filter(|entry| entry.path().is_dir())
        .map(|entry| {
            let full = entry.path();
            FsEntry {
                name: entry.file_name().to_string_lossy().into_owned(),
                is_git: orbyn_core::git::is_git_repo(&full),
                path: full.to_string_lossy().into_owned(),
            }
        })
        .collect();
    entries.sort_by_key(|entry| entry.name.to_lowercase());
    Ok(Json(FsListing {
        parent: path
            .parent()
            .map(FsPath::to_string_lossy)
            .map(std::borrow::Cow::into_owned),
        path: path.to_string_lossy().into_owned(),
        entries,
    }))
}

#[derive(Deserialize)]
pub struct ThreadsQuery {
    project_id: Option<String>,
    archived: Option<bool>,
}

pub async fn list_threads(
    State(state): State<AppState>,
    Query(query): Query<ThreadsQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.store.list_threads(
        query.project_id.as_deref(),
        query.archived.unwrap_or(false),
    )?))
}

pub async fn create_thread(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CreateThread>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(state.core.create_thread(body).await?),
    ))
}

pub async fn get_thread(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.store.thread(&id)?))
}

pub async fn delete_thread(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.delete_thread(&id, LOCAL_USER)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn update_thread(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(patch): ApiJson<UpdateThread>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.update_thread(&id, &patch, LOCAL_USER)?))
}

pub async fn regenerate_title(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.regenerate_title(&id, LOCAL_USER).await?))
}

pub async fn reorder_threads(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<ReorderThreads>,
) -> ApiResult<StatusCode> {
    state.core.store.reorder_threads(&body.ids)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn get_settings(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.store.settings()?))
}

pub async fn put_settings(
    State(state): State<AppState>,
    ApiJson(settings): ApiJson<ServerSettings>,
) -> ApiResult<impl IntoResponse> {
    state.core.store.save_settings(&settings, LOCAL_USER)?;
    Ok(Json(settings))
}

pub async fn start_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<StartRun>,
) -> ApiResult<impl IntoResponse> {
    let run = state.core.runs.admit(&id, &body.prompt, LOCAL_USER)?;
    Ok((StatusCode::ACCEPTED, Json(run)))
}

pub async fn cancel_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.runs.cancel(&id)?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
pub struct ApprovalsQuery {
    state: Option<String>,
}

pub async fn list_approvals(
    State(state): State<AppState>,
    Query(query): Query<ApprovalsQuery>,
) -> ApiResult<impl IntoResponse> {
    let filter = query
        .state
        .map(|text| {
            serde_json::from_value::<ApprovalState>(Value::String(text))
                .map_err(|_| CoreError::Invalid("Unknown approval state.".into()))
        })
        .transpose()?;
    Ok(Json(state.core.store.list_approvals(filter)?))
}

pub async fn decide_approval(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<DecideApproval>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.gate.decide(
        &id,
        body.allow,
        body.remember,
        LOCAL_USER,
    )?))
}

pub async fn thread_diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.thread_diff(&id).await?))
}

pub async fn list_engines(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.engines.statuses(false).await?))
}

pub async fn refresh_engines(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.engines.statuses(true).await?))
}

pub async fn update_engine(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.engines.update(&id, LOCAL_USER).await?))
}

fn slug(name: &str) -> String {
    let text: String = name
        .to_lowercase()
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() { c } else { '-' })
        .collect();
    text.split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-")
}

pub async fn add_custom_engine(
    State(state): State<AppState>,
    ApiJson(mut engine): ApiJson<CustomEngine>,
) -> ApiResult<impl IntoResponse> {
    if engine.id.is_empty() {
        engine.id = slug(&engine.name);
    }
    if engine.id.is_empty() || engine.name.trim().is_empty() || engine.target.trim().is_empty() {
        return Err(
            CoreError::Invalid("Name the engine and give its command or URL.".into()).into(),
        );
    }
    if matches!(engine.id.as_str(), "claude" | "codex") || engine.tier == EngineTier::Native {
        return Err(CoreError::Invalid("That engine is built in.".into()).into());
    }
    if engine.tier == EngineTier::Agui
        && !(engine.target.starts_with("http://") || engine.target.starts_with("https://"))
    {
        return Err(
            CoreError::Invalid("An AG-UI engine needs an http or https URL.".into()).into(),
        );
    }
    state.core.store.save_custom_engine(&engine, LOCAL_USER)?;
    state.core.engines.invalidate().await;
    Ok((
        StatusCode::CREATED,
        Json(state.core.engines.status(&engine.id).await?),
    ))
}

pub async fn delete_custom_engine(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.store.delete_custom_engine(&id, LOCAL_USER)?;
    state.core.engines.invalidate().await;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn skills(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.skills.status()?))
}

pub async fn rebuild_skills(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.skills.rebuild()?))
}

pub async fn list_profiles(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.skills.profiles()?))
}

pub async fn create_profile(
    State(state): State<AppState>,
    ApiJson(mut profile): ApiJson<SkillProfile>,
) -> ApiResult<impl IntoResponse> {
    if profile.id == DEFAULT_PROFILE {
        return Err(CoreError::Invalid("The default profile is built in.".into()).into());
    }
    if profile.name.trim().is_empty() {
        return Err(CoreError::Invalid("Name this profile.".into()).into());
    }
    if profile.id.is_empty() {
        profile.id = new_id();
    }
    state.core.store.save_profile(&profile)?;
    Ok((StatusCode::CREATED, Json(profile)))
}

pub async fn delete_profile(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    if id == DEFAULT_PROFILE {
        return Err(CoreError::Invalid("The default profile is built in.".into()).into());
    }
    state.core.store.delete_profile(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn list_rules(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.store.list_rules()?))
}

pub async fn create_rule(
    State(state): State<AppState>,
    ApiJson(rule): ApiJson<CreatePolicyRule>,
) -> ApiResult<impl IntoResponse> {
    if rule.pattern.is_empty() {
        return Err(CoreError::Invalid("Enter a pattern.".into()).into());
    }
    Ok((
        StatusCode::CREATED,
        Json(state.core.store.add_rule(&rule, LOCAL_USER)?),
    ))
}

pub async fn delete_rule(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.store.delete_rule(&id, LOCAL_USER)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct AuditQuery {
    thread_id: Option<String>,
    limit: Option<u32>,
}

pub async fn audit(
    State(state): State<AppState>,
    Query(query): Query<AuditQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.store.list_audit(
        query.thread_id.as_deref(),
        query.limit.unwrap_or(200),
    )?))
}

pub async fn computer_status(
    State(state): State<AppState>,
) -> Json<orbyn_contracts::ComputerStatus> {
    Json(state.core.computer.status())
}

/// Runs against the thread's active run when there is one, so `ask` can reach a
/// person. With no run, only an explicit allow rule passes.
pub async fn computer_action(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(action): ApiJson<ComputerAction>,
) -> ApiResult<impl IntoResponse> {
    let thread = state.core.store.thread(&id)?;
    let result = match &thread.active_run {
        Some(run) => {
            let scope = orbyn_core::approvals::RunScope {
                run_id: run.id.clone(),
                thread_id: thread.id.clone(),
                engine: thread.engine.clone(),
            };
            state.core.computer.act(Caller::Run(&scope), action).await?
        }
        None => {
            let caller = Caller::Direct {
                thread_id: &thread.id,
                actor: LOCAL_USER,
            };
            state.core.computer.act(caller, action).await?
        }
    };
    Ok(Json(result))
}

#[derive(Deserialize)]
pub struct SessionRequest {
    key: String,
}

pub async fn open_session(
    State(state): State<AppState>,
    headers: HeaderMap,
    ApiJson(body): ApiJson<SessionRequest>,
) -> ApiResult<Response> {
    let Some(session) = state.access.open_session(&body.key) else {
        tokio::time::sleep(std::time::Duration::from_millis(250)).await;
        return Err(ApiFailure::new(
            StatusCode::UNAUTHORIZED,
            "invalid_key",
            "That access key is not valid.",
        ));
    };
    let secure = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        == Some("https");
    Ok((
        StatusCode::NO_CONTENT,
        [(header::SET_COOKIE, Access::session_cookie(&session, secure))],
    )
        .into_response())
}

/// `POST /mcp/:thread_token`. The token is the only credential on this route.
pub async fn mcp(
    State(state): State<AppState>,
    Path(token): Path<String>,
    ApiJson(message): ApiJson<Value>,
) -> Response {
    // Drop-safe in core: a client that disconnects mid-approval expires it.
    match state.core.mcp.handle(&token, &message).await {
        Ok(Some(reply)) => Json(reply).into_response(),
        Ok(None) => StatusCode::ACCEPTED.into_response(),
        Err(_) => ApiFailure::new(
            StatusCode::NOT_FOUND,
            "unknown_token",
            "This MCP session has ended.",
        )
        .into_response(),
    }
}

pub async fn mcp_get() -> Response {
    (
        StatusCode::METHOD_NOT_ALLOWED,
        [(header::ALLOW, "POST")],
        Json(
            json!({ "code": "method_not_allowed", "message": "This server has no event stream." }),
        ),
    )
        .into_response()
}

pub type QueryMap = Query<HashMap<String, String>>;
