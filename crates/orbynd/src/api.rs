//! The HTTP API from docs/architecture.md. Handlers parse, call core and map the
//! result; all product rules live in `orbyn-core`.

use std::collections::HashMap;
use std::path::{Path as FsPath, PathBuf};
use std::sync::Arc;

use axum::Json;
use axum::extract::{FromRequest, Path, Query, Request, State};
use axum::http::{HeaderMap, StatusCode, header};
use axum::response::{IntoResponse, Response};
use orbyn_contracts::ModelSelection;
use orbyn_contracts::{
    AddProject, AdoptScratch, AnswerQuestion, ApiError, ApprovalState, BatchThreads, CloneProject,
    ComputerAction, CreateBranch, CreatePolicyRule, CreateThread, CustomEngine, DecideApproval,
    DelegateTask, EditQueuedMessage, EngineTier, EnqueueMessage, ForkThread, FsEntry, FsListing,
    GitAction, InstallAcpAgent, KeybindingRule, LibraryUpdateRequest, LinkPull, MergePull,
    MoveThread, NewProject, OpenInEditor, OtlpCheck, PublishProject, QuestionState, RenameProject,
    ReorderThreads, RestoreChanges, RestoreWorkspace, RewindThread, ServerInfo, ServerSettings,
    SetPreferences, SkillProfile, StartRun, SteerResult, SteerRun, SubmitReview, SwitchBranch,
    SwitchEngine, TaskEnabled, UpdateThread, UpsertTask, WorkspaceSetup, WriteFile,
};
use orbyn_core::computer::Caller;
use orbyn_core::selection;
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
            CoreError::QuestionClosed(existing) => serde_json::to_value(existing).ok(),
            CoreError::ProjectExists(existing) => serde_json::to_value(existing).ok(),
            CoreError::ProjectHasWork { detail, .. } => Some(detail.clone()),
            CoreError::FileConflict { revision } => Some(json!({ "revision": revision })),
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

/// A request that changes something means a person is here, which puts off an
/// automatic update. Reads don't count: a window left open polls.
pub async fn note_activity(
    State(state): State<AppState>,
    request: Request,
    next: axum::middleware::Next,
) -> Response {
    if request.method() != axum::http::Method::GET {
        state.core.updates.note_activity();
    }
    next.run(request).await
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

pub async fn clone_project(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CloneProject>,
) -> ApiResult<impl IntoResponse> {
    let project = state
        .core
        .clone_project(&body.url, body.name.as_deref(), body.path.as_deref())
        .await?;
    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn list_clones(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.core.clone_jobs())
}

pub async fn start_clone(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<CloneProject>,
) -> ApiResult<impl IntoResponse> {
    let job = state
        .core
        .start_clone(&body.url, body.name.as_deref(), body.path.as_deref())?;
    Ok((StatusCode::ACCEPTED, Json(job)))
}

pub async fn cancel_clone(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.cancel_clone(&id)?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn retry_clone(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok((StatusCode::ACCEPTED, Json(state.core.retry_clone(&id)?)))
}

pub async fn create_project(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<NewProject>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .core
                .new_project(&body.name, body.readme, body.path.as_deref())
                .await?,
        ),
    ))
}

pub async fn add_project(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<AddProject>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(state.core.add_project(&body.path).await?),
    ))
}

pub async fn move_thread(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<MoveThread>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state.core.move_thread(&id, body.project_id.as_deref())?,
    ))
}

pub async fn adopt_scratch(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<AdoptScratch>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.adopt_scratch(&id, body.name.as_deref())?))
}

#[derive(Deserialize)]
pub struct RemoveQuery {
    confirm: Option<bool>,
    delete_files: Option<bool>,
}

pub async fn remove_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<RemoveQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state
            .core
            .remove_project(
                &id,
                query.confirm.unwrap_or(false),
                query.delete_files.unwrap_or(false),
            )
            .await?,
    ))
}

pub async fn workspace_status(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    let projects = state.core.store.list_projects()?;
    Ok(Json(state.core.workspace.status(&projects).await?))
}

pub async fn workspace_setup(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<WorkspaceSetup>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.setup_workspace(body).await?))
}

pub async fn workspace_update(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<LibraryUpdateRequest>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.workspace.update(body.apply).await?))
}

pub async fn workspace_rollback(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.workspace.rollback().await?))
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

pub async fn updates(State(state): State<AppState>) -> Json<orbyn_contracts::UpdateStatus> {
    Json(state.core.updates.status().await)
}

pub async fn check_updates(State(state): State<AppState>) -> Json<orbyn_contracts::UpdateStatus> {
    Json(state.core.updates.check().await)
}

pub async fn apply_app_update(State(state): State<AppState>) -> ApiResult<StatusCode> {
    state.core.updates.apply_app(LOCAL_USER).await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn apply_all_updates(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.updates.apply_all(LOCAL_USER).await?))
}

pub async fn list_items(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    state.core.store.thread(&id)?;
    Ok(Json(state.core.store.items(&id, 500)?))
}

pub async fn run_changes(
    State(state): State<AppState>,
    Path((id, run)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.run_changes(&id, &run)?))
}

#[derive(Deserialize)]
pub struct ChangedFileQuery {
    path: String,
}

pub async fn changed_file(
    State(state): State<AppState>,
    Path((id, run)): Path<(String, String)>,
    Query(query): Query<ChangedFileQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.changed_file(&id, &run, &query.path)?))
}

pub async fn restore_changes(
    State(state): State<AppState>,
    Path((id, run)): Path<(String, String)>,
    ApiJson(body): ApiJson<RestoreChanges>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state.core.restore_changes(&id, &run, &body, LOCAL_USER)?,
    ))
}

pub async fn network_requests(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.network_requests()?))
}

pub async fn get_item(
    State(state): State<AppState>,
    Path((id, item)): Path<(String, String)>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.store.item(&id, &item)?))
}

pub async fn thread_usage(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.store.usage(&id)?))
}

#[derive(Deserialize)]
pub struct PathQuery {
    #[serde(default)]
    path: String,
}

pub async fn file_tree(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PathQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.list_files(&id, &query.path).await?))
}

pub async fn ignored_files(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.ignored_files(&id).await?))
}

pub async fn read_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PathQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.read_file(&id, &query.path).await?))
}

pub async fn write_file(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<WriteFile>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.write_file(&id, &body, LOCAL_USER).await?))
}

#[derive(Deserialize)]
pub struct SearchQuery {
    q: String,
    #[serde(default)]
    content: bool,
}

pub async fn search_files(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<SearchQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state
            .core
            .search_files(&id, &query.q, query.content)
            .await?,
    ))
}

pub async fn editors() -> Json<Vec<orbyn_contracts::EditorInfo>> {
    Json(orbyn_core::files::installed_editors())
}

pub async fn open_in_editor(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<OpenInEditor>,
) -> ApiResult<StatusCode> {
    state.core.open_in_editor(&id, &body, LOCAL_USER).await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn git_action(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<GitAction>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.git_action(&id, &body, LOCAL_USER).await?))
}

pub async fn branches(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.branches(&id).await?))
}

pub async fn create_branch(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<CreateBranch>,
) -> ApiResult<StatusCode> {
    state.core.create_branch(&id, &body, LOCAL_USER).await?;
    Ok(StatusCode::CREATED)
}

pub async fn switch_branch(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<SwitchBranch>,
) -> ApiResult<StatusCode> {
    state
        .core
        .switch_branch(&id, &body.name, LOCAL_USER)
        .await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn linked_pulls(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    state.core.store.thread(&id)?;
    Ok(Json(state.core.store.linked_pulls(&id)?))
}

pub async fn link_pull(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<LinkPull>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(state.core.link_pull(&id, body.number).await?),
    ))
}

pub async fn unlink_pull(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
) -> ApiResult<StatusCode> {
    state.core.store.unlink_pull(&id, number)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn refresh_pulls(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.refresh_pulls(&id).await?))
}

pub async fn pull_detail(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.pull_detail(&id, number).await?))
}

pub async fn review_pull(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<SubmitReview>,
) -> ApiResult<StatusCode> {
    state
        .core
        .review_pull(&id, number, &body, LOCAL_USER)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn merge_pull(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<MergePull>,
) -> ApiResult<StatusCode> {
    state
        .core
        .merge_pull(&id, number, &body, LOCAL_USER)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn publish_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<PublishProject>,
) -> ApiResult<StatusCode> {
    state.core.publish_project(&id, &body, LOCAL_USER).await?;
    Ok(StatusCode::ACCEPTED)
}

fn period(query: &HashMap<String, String>) -> ApiResult<Option<u32>> {
    query
        .get("days")
        .map(|days| {
            days.parse().map_err(|_| {
                ApiFailure::new(
                    StatusCode::BAD_REQUEST,
                    "invalid_input",
                    "`days` must be a number.",
                )
            })
        })
        .transpose()
}

pub async fn usage(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    let settings = state.core.store.settings()?;
    let days = period(&query)?;
    Ok(Json(state.core.usage.report(&settings, days).await?))
}

/// Reads history and limits again from their sources, and rereads prices.
pub async fn refresh_usage(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    state.core.usage.forget();
    let settings = state.core.store.settings()?;
    let days = period(&query)?;
    Ok(Json(state.core.usage.report(&settings, days).await?))
}

fn forced(query: &HashMap<String, String>) -> bool {
    query.get("force").is_some_and(|value| value == "true")
}

pub async fn limits_overview(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.limits_overview(forced(&query)).await?))
}

pub async fn thread_limits(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    let engine = state.core.store.thread(&id)?.engine;
    Ok(Json(
        state.core.engine_limits(&engine, forced(&query)).await?,
    ))
}

pub async fn engine_limits(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.engine_limits(&id, forced(&query)).await?))
}

pub async fn tasks(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.tasks()?))
}

pub async fn save_task(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<UpsertTask>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.save_task(body, LOCAL_USER)?))
}

pub async fn update_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<UpsertTask>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.update_task(&id, body, LOCAL_USER)?))
}

pub async fn set_task_enabled(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<TaskEnabled>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.set_task_enabled(&id, body.enabled)?))
}

pub async fn delete_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.delete_task(&id, LOCAL_USER)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn run_task(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    let thread = state.core.run_task(&id).await?;
    Ok((StatusCode::ACCEPTED, Json(json!({ "thread_id": thread }))))
}

pub async fn rotate_webhook(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.rotate_webhook(&id, LOCAL_USER)?))
}

pub async fn task_deliveries(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.deliveries(&id)?))
}

/// Public, because a sender cannot hold a session. The token in the path is the
/// credential, and a wrong one is the same `404` as an unknown task.
pub async fn webhook(
    State(state): State<AppState>,
    Path((id, token)): Path<(String, String)>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<impl IntoResponse> {
    let headers = headers
        .iter()
        .filter_map(|(name, value)| {
            Some((name.as_str().to_owned(), value.to_str().ok()?.to_owned()))
        })
        .collect();
    match state.core.webhook(&id, &token, &headers, &body).await {
        Ok(delivery) => {
            let status = if delivery.status == "accepted" {
                StatusCode::ACCEPTED
            } else {
                StatusCode::OK
            };
            Ok((
                status,
                Json(json!({ "status": delivery.status, "id": delivery.id })),
            ))
        }
        Err(_) => Err(ApiFailure::new(
            StatusCode::NOT_FOUND,
            "not_found",
            "Not found.",
        )),
    }
}

pub async fn delegate(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<DelegateTask>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(state.core.delegate(&id, &body, LOCAL_USER)?),
    ))
}

pub async fn batch_threads(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<BatchThreads>,
) -> impl IntoResponse {
    Json(state.core.batch_threads(body.threads).await)
}

pub async fn preferences(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    let project = query.get("project_id").map(String::as_str);
    Ok(Json(state.core.preferences(project)?))
}

pub async fn set_preferences(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<SetPreferences>,
) -> ApiResult<impl IntoResponse> {
    state.core.set_preferences(None, &body.values)?;
    Ok(Json(state.core.preferences(None)?))
}

pub async fn set_project_preferences(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<SetPreferences>,
) -> ApiResult<impl IntoResponse> {
    state.core.store.project(&id)?;
    state.core.set_preferences(Some(&id), &body.values)?;
    Ok(Json(state.core.preferences(Some(&id))?))
}

pub async fn keybindings(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.core.keybindings())
}

pub async fn save_keybinding(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<KeybindingRule>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.save_keybinding(&body)?))
}

pub async fn diagnostics(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.diagnostics()?))
}

pub async fn repair_database(State(state): State<AppState>) -> ApiResult<StatusCode> {
    state.core.repair_database()?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn check_otlp(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<OtlpCheck>,
) -> impl IntoResponse {
    Json(state.core.check_otlp(&body.url).await)
}

pub async fn storage_cleanup(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    let dry_run = query.get("dry_run").is_some_and(|value| value == "true");
    Ok(Json(state.core.storage_cleanup(dry_run).await?))
}

pub async fn cleanup_report(State(state): State<AppState>) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.cleanup_report()?))
}

pub async fn pull_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.pull_project(&id, LOCAL_USER).await?;
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
    let wanted = ModelSelection {
        model: body.model.clone(),
        effort: body.effort.clone(),
        options: body.options.clone(),
    };
    state.core.check_turn(&id, &wanted).await?;
    if body.permission_mode.is_some() || !selection::is_empty(&wanted) {
        let patch = UpdateThread {
            permission_mode: body.permission_mode,
            model: wanted.model,
            effort: wanted.effort,
            options: Some(wanted.options),
            ..UpdateThread::default()
        };
        state.core.update_thread(&id, &patch, LOCAL_USER)?;
    }
    let run = state
        .core
        .runs
        .admit_with(&id, &body.prompt, &body.attachment_ids, LOCAL_USER)?;
    Ok((StatusCode::ACCEPTED, Json(run)))
}

pub async fn list_queue(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    state.core.store.thread(&id)?;
    Ok(Json(state.core.store.list_queue(&id)?))
}

pub async fn enqueue(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<EnqueueMessage>,
) -> ApiResult<impl IntoResponse> {
    let wanted = ModelSelection {
        model: body.model,
        effort: body.effort,
        options: body.options,
    };
    state.core.check_turn(&id, &wanted).await?;
    let message = state
        .core
        .runs
        .enqueue_with(&id, &body.prompt, &body.attachment_ids, &wanted)?;
    Ok((StatusCode::CREATED, Json(message)))
}

pub async fn edit_queued(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<EditQueuedMessage>,
) -> ApiResult<impl IntoResponse> {
    orbyn_core::composer::check_prompt(&body.prompt)?;
    Ok(Json(state.core.store.edit_queued(&id, &body.prompt)?))
}

pub async fn remove_queued(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.store.remove_queued(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn send_queued_now(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.runs.send_now(&id)?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn resume_queue(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.runs.resume_queue(&id)?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn steer(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<SteerRun>,
) -> ApiResult<impl IntoResponse> {
    let wanted = ModelSelection {
        model: body.model,
        effort: body.effort,
        options: body.options,
    };
    state.core.check_turn(&id, &wanted).await?;
    let delivered = state.core.runs.steer(&id, &body.prompt)?;
    if !selection::is_empty(&wanted) {
        let patch = UpdateThread {
            model: wanted.model,
            effort: wanted.effort,
            options: Some(wanted.options),
            ..UpdateThread::default()
        };
        state.core.update_thread(&id, &patch, LOCAL_USER)?;
    }
    Ok((StatusCode::ACCEPTED, Json(SteerResult { state: delivered })))
}

#[derive(Deserialize)]
pub struct UploadQuery {
    name: String,
}

pub async fn upload_attachment(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<UploadQuery>,
    headers: HeaderMap,
    body: axum::body::Bytes,
) -> ApiResult<impl IntoResponse> {
    let mime = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("application/octet-stream");
    let attachment = state.core.add_attachment(&id, &query.name, mime, &body)?;
    Ok((StatusCode::CREATED, Json(attachment)))
}

pub async fn list_attachments(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    state.core.store.thread(&id)?;
    let attachments: Vec<_> = state
        .core
        .store
        .list_attachments(&id)?
        .into_iter()
        .map(|(attachment, _)| attachment)
        .collect();
    Ok(Json(attachments))
}

pub async fn remove_attachment(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.remove_attachment(&id)?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Deserialize)]
pub struct MentionQuery {
    #[serde(default)]
    q: String,
}

pub async fn mentions(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<MentionQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.mentions(&id, &query.q).await?))
}

pub async fn slash_commands(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    let skills = query.get("skills").is_some_and(|value| value == "true");
    Ok(Json(state.core.slash_commands(&id, skills).await?))
}

pub async fn engine_models(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    let refresh = query.get("refresh").is_some_and(|value| value == "true");
    Ok(Json(state.core.engine_models(&id, refresh).await?))
}

pub async fn list_questions(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    let filter = query
        .get("state")
        .map(|text| serde_json::from_value::<QuestionState>(json!(text)))
        .transpose()
        .map_err(|_| ApiFailure::new(StatusCode::BAD_REQUEST, "invalid_input", "Unknown state."))?;
    let thread = query.get("thread_id").map(String::as_str);
    Ok(Json(state.core.store.list_questions(thread, filter)?))
}

pub async fn answer_question(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<AnswerQuestion>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.questions.answer(
        &id,
        body.answers,
        LOCAL_USER,
    )?))
}

pub async fn dismiss_question(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.questions.dismiss(&id, LOCAL_USER)?))
}

pub async fn cancel_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.runs.cancel(&id)?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
pub struct MessageSearchQuery {
    q: String,
    project_id: Option<String>,
    thread_id: Option<String>,
    limit: Option<usize>,
    archived: Option<bool>,
}

pub async fn search_messages(
    State(state): State<AppState>,
    Query(query): Query<MessageSearchQuery>,
) -> ApiResult<impl IntoResponse> {
    let scope = orbyn_core::search::SearchScope {
        project_id: query.project_id,
        thread_id: query.thread_id,
        archived: query.archived.unwrap_or(false),
        limit: query.limit,
    };
    Ok(Json(state.core.store.search_messages(&query.q, &scope)?))
}

#[derive(Deserialize)]
pub struct MessagesQuery {
    limit: Option<usize>,
}

pub async fn thread_messages(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<MessagesQuery>,
) -> ApiResult<impl IntoResponse> {
    let limit = query.limit.unwrap_or(200);
    Ok(Json(state.core.store.thread_messages(&id, limit)?))
}

pub async fn rename_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<RenameProject>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.rename_project(&id, &body.name)?))
}

pub async fn force_stop(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.runs.force_stop(&id, LOCAL_USER).await?))
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
    Ok(Json(state.core.gate.decide_with(
        &id,
        body.allow,
        body.remember,
        body.feedback,
        LOCAL_USER,
    )?))
}

#[derive(Deserialize)]
pub struct DiffQuery {
    /// `worktree` by default, or `turn`, `thread`, `branch` or `commit`.
    scope: Option<String>,
    run: Option<String>,
    base: Option<String>,
    sha: Option<String>,
}

pub async fn thread_diff(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<DiffQuery>,
) -> ApiResult<impl IntoResponse> {
    let core = &state.core;
    let missing = |what: &str| CoreError::Invalid(format!("This diff needs {what}."));
    let files = match query.scope.as_deref() {
        None | Some("worktree") => core.thread_diff(&id).await?,
        Some("turn") => {
            let run = query.run.ok_or_else(|| missing("a run"))?;
            core.turn_diff(&id, &run).await?
        }
        Some("thread") => core.full_thread_diff(&id).await?,
        Some("branch") => {
            let base = query.base.ok_or_else(|| missing("a base branch"))?;
            core.branch_diff(&id, &base).await?
        }
        Some("commit") => {
            let sha = query.sha.ok_or_else(|| missing("a commit"))?;
            core.commit_diff(&id, &sha).await?
        }
        Some(_) => return Err(CoreError::Invalid("Unknown diff scope.".into()).into()),
    };
    Ok(Json(files))
}

pub async fn commits(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.thread_commits(&id).await?))
}

pub async fn checkpoints(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    state.core.store.thread(&id)?;
    Ok(Json(state.core.store.checkpoints(&id)?))
}

pub async fn restore_workspace(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<RestoreWorkspace>,
) -> ApiResult<StatusCode> {
    state.core.restore_workspace(&id, &body, LOCAL_USER).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn rewind_thread(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<RewindThread>,
) -> ApiResult<StatusCode> {
    state.core.rewind_thread(&id, &body, LOCAL_USER).await?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn fork_thread(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<ForkThread>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(state.core.fork_thread(&id, &body, LOCAL_USER)?),
    ))
}

pub async fn restart_session(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    state.core.restart_session(&id, LOCAL_USER)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn bring_back(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    state.core.bring_back(&id, LOCAL_USER)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn switch_engine(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<SwitchEngine>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.switch_engine(&id, &body, LOCAL_USER)?))
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

#[derive(Deserialize)]
pub struct RegistryQuery {
    #[serde(default)]
    q: String,
}

pub async fn search_acp_registry(
    State(state): State<AppState>,
    Query(query): Query<RegistryQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.search_acp_registry(&query.q).await?))
}

pub async fn install_acp_agent(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<InstallAcpAgent>,
) -> ApiResult<impl IntoResponse> {
    let engine = state
        .core
        .install_acp_agent(&id, body.distribution.as_deref(), LOCAL_USER)
        .await?;
    Ok((StatusCode::CREATED, Json(engine)))
}

pub async fn remove_acp_agent(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<StatusCode> {
    state.core.remove_acp_agent(&id, LOCAL_USER).await?;
    Ok(StatusCode::NO_CONTENT)
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
    Ok(Json(state.core.skills.status().await?))
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
                write_scope: None,
                mode: orbyn_contracts::PermissionMode::Supervised,
                plan: false,
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
