//! Pull request routes: a project's forge read and written through its own CLI.

use std::collections::HashMap;

use axum::Json;
use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::response::IntoResponse;
use orbyn_contracts::{
    AddPullComment, BulkClosePulls, CheckoutPull, EditPullComment, MergePull, PullAction,
    ReactPullComment, ResolvePullThread, SetFilesViewed, SetPullPeople, StackAction, SubmitReview,
    UpdatePull, WorkOnPull,
};
use orbyn_core::forge::PullFilter;

use crate::api::{ApiJson, ApiResult, AppState, LOCAL_USER};

fn filter_of(query: HashMap<String, String>) -> PullFilter {
    let mut query = query;
    PullFilter {
        state: query.remove("state").unwrap_or_else(|| "open".to_owned()),
        search: query.remove("q").filter(|text| !text.is_empty()),
        author: query.remove("author").filter(|text| !text.is_empty()),
        label: query.remove("label").filter(|text| !text.is_empty()),
        head: None,
    }
}

pub async fn all(
    State(state): State<AppState>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.all_pulls(&filter_of(query)).await?))
}

pub async fn list(
    State(state): State<AppState>,
    Path(id): Path<String>,
    Query(query): Query<HashMap<String, String>>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state.core.project_pulls(&id, &filter_of(query)).await?,
    ))
}

pub async fn detail(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.project_pull(&id, number).await?))
}

pub async fn update(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<UpdatePull>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state
            .core
            .update_pull(&id, number, &body, LOCAL_USER)
            .await?,
    ))
}

pub async fn checks(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.pull_checks(&id, number).await?))
}

pub async fn approve_workflow(
    State(state): State<AppState>,
    Path((id, run)): Path<(String, u64)>,
) -> ApiResult<StatusCode> {
    state.core.approve_workflow(&id, run, LOCAL_USER).await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn conversation(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.pull_conversation(&id, number).await?))
}

pub async fn timeline(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.pull_timeline(&id, number).await?))
}

pub async fn files(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.pull_files(&id, number).await?))
}

pub async fn set_viewed(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<SetFilesViewed>,
) -> ApiResult<StatusCode> {
    state
        .core
        .set_files_viewed(&id, number, &body.paths, body.viewed)?;
    Ok(StatusCode::NO_CONTENT)
}

pub async fn comment(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<AddPullComment>,
) -> ApiResult<StatusCode> {
    state
        .core
        .comment_pull(&id, number, &body, LOCAL_USER)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn edit_comment(
    State(state): State<AppState>,
    Path((id, number, comment)): Path<(String, u64, String)>,
    ApiJson(body): ApiJson<EditPullComment>,
) -> ApiResult<StatusCode> {
    state
        .core
        .edit_pull_comment(&id, number, &comment, &body, LOCAL_USER)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn react(
    State(state): State<AppState>,
    Path((id, number, comment)): Path<(String, u64, String)>,
    ApiJson(body): ApiJson<ReactPullComment>,
) -> ApiResult<StatusCode> {
    state
        .core
        .react_pull_comment(&id, number, &comment, &body)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn resolve_thread(
    State(state): State<AppState>,
    Path((id, number, thread)): Path<(String, u64, String)>,
    ApiJson(body): ApiJson<ResolvePullThread>,
) -> ApiResult<StatusCode> {
    state
        .core
        .resolve_pull_thread(&id, number, &thread, body.resolved, LOCAL_USER)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn review(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<SubmitReview>,
) -> ApiResult<StatusCode> {
    state
        .core
        .submit_pull_review(&id, number, &body, LOCAL_USER)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn reviewer_candidates(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.pull_reviewers(&id).await?))
}

pub async fn label_candidates(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.pull_labels(&id).await?))
}

pub async fn set_reviewers(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<SetPullPeople>,
) -> ApiResult<StatusCode> {
    state
        .core
        .set_pull_reviewers(&id, number, &body, LOCAL_USER)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn set_labels(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<SetPullPeople>,
) -> ApiResult<StatusCode> {
    state
        .core
        .set_pull_labels(&id, number, &body, LOCAL_USER)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn merge(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<MergePull>,
) -> ApiResult<StatusCode> {
    state
        .core
        .merge_project_pull(&id, number, &body, LOCAL_USER)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn action(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<PullAction>,
) -> ApiResult<StatusCode> {
    state
        .core
        .pull_action(&id, number, &body.action, LOCAL_USER)
        .await?;
    Ok(StatusCode::ACCEPTED)
}

pub async fn close_many(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(body): ApiJson<BulkClosePulls>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state
            .core
            .close_pulls(&id, &body.numbers, LOCAL_USER)
            .await?,
    ))
}

pub async fn stack(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.pull_stack(&id, number).await?))
}

pub async fn stack_action(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<StackAction>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state
            .core
            .stack_action(&id, number, &body, LOCAL_USER)
            .await?,
    ))
}

pub async fn checkout(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<CheckoutPull>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(
        state
            .core
            .checkout_pull(&id, number, &body, LOCAL_USER)
            .await?,
    ))
}

pub async fn work_on(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
    ApiJson(body): ApiJson<WorkOnPull>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(
            state
                .core
                .work_on_pull(&id, number, &body, LOCAL_USER)
                .await?,
        ),
    ))
}

pub async fn watches(
    State(state): State<AppState>,
    Path(id): Path<String>,
) -> ApiResult<impl IntoResponse> {
    Ok(Json(state.core.thread_watches(&id)?))
}

pub async fn watch(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
) -> ApiResult<impl IntoResponse> {
    Ok((
        StatusCode::CREATED,
        Json(state.core.watch_pull(&id, number)?),
    ))
}

pub async fn unwatch(
    State(state): State<AppState>,
    Path((id, number)): Path<(String, u64)>,
) -> ApiResult<StatusCode> {
    state.core.store.unwatch_pull(&id, number)?;
    Ok(StatusCode::NO_CONTENT)
}

/// One pass of the watch now, rather than at the next two-minute tick.
pub async fn check_watches(State(state): State<AppState>) -> StatusCode {
    state.core.watch_pulls().await;
    StatusCode::NO_CONTENT
}

pub async fn forges(State(state): State<AppState>) -> impl IntoResponse {
    Json(state.core.forges().await)
}
