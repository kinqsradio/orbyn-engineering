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
    AnswerQuestion, ApiError, ApprovalState, CloneProject, ComputerAction, CreateBranch,
    CreatePolicyRule, CreateThread, CustomEngine, DecideApproval, EditQueuedMessage, EngineTier,
    EnqueueMessage, ForkThread, FsEntry, FsListing, GitAction, ImportProject, LibraryUpdateRequest,
    LinkPull, MergePull, NewProject, OpenInEditor, PublishProject, QuestionState, ReorderThreads,
    RestoreWorkspace, RewindThread, ServerInfo, ServerSettings, SkillProfile, StartRun, SteerRun,
    SubmitReview, SwitchBranch, SwitchEngine, UpdateThread, WorkspaceSetup, WriteFile,
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
            CoreError::QuestionClosed(existing) => serde_json::to_value(existing).ok(),
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
        .clone_project(&body.url, body.name.as_deref())
        .await?;
    Ok((StatusCode::CREATED, Json(project)))
}

pub async fn create_project(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<NewProject>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(state.core.new_project(&body.name).await?),
    ))
}

pub async fn import_project(
    State(state): State<AppState>,
    ApiJson(body): ApiJson<ImportProject>,
) -> ApiResult<impl IntoResponse> {
    let report = state
        .core
        .import_project(&body.path, body.name.as_deref())
        .await?;
    Ok((StatusCode::CREATED, Json(report)))
}

#[derive(Deserialize)]
pub struct RemoveQuery {
    confirm: Option<bool>,
}

pub async fn remove_project(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<RemoveQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state
            .core
            .remove_project(&id, query.confirm.unwrap_or(false))
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
        .merge_pull(&id, number, &body.method, LOCAL_USER)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

#[derive(Deserialize)]
pub struct PullListQuery {
    state: Option<String>,
}

pub async fn project_pulls(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<PullListQuery>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state
            .core
            .project_pulls(&id, query.state.as_deref().unwrap_or("open"))
            .await?,
    ))
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
    if body.permission_mode.is_some() || body.model.is_some() || body.effort.is_some() {
        let patch = UpdateThread {
            permission_mode: body.permission_mode,
            model: body.model.clone(),
            effort: body.effort.clone(),
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
    let message = state
        .core
        .runs
        .enqueue(&id, &body.prompt, &body.attachment_ids)?;
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
) -> ApiResult<StatusCode> {
    state.core.runs.steer(&id, &body.prompt)?;
    Ok(StatusCode::ACCEPTED)
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
    Ok(Json(state.core.slash_commands(&id, skills)?))
}

pub async fn engine_models(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    let refresh = query.get("refresh").is_some_and(|value| value == "true");
    Ok(Json(state.core.engines.models(&id, refresh).await?))
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
