//! Log-following streams. A client always reads from the log: replay and live
//! are the same loop, so the switch between them cannot gap or duplicate.

use std::collections::VecDeque;
use std::convert::Infallible;
use std::sync::Arc;
use std::time::Duration;

use axum::extract::{Path, State};
use axum::http::HeaderMap;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use futures_util::{Stream, StreamExt, stream};
use orbyn_contracts::{AgUiEvent, ApprovalState, ThreadEvent};
use orbyn_core::store::Store;
use orbyn_core::{Core, CoreError};
use serde_json::{Value, json};
use tokio::sync::watch;

use crate::api::{ApiJson, ApiResult, AppState, QueryMap};

const BATCH: u32 = 500;
const KEEP_ALIVE: Duration = Duration::from_secs(15);
/// The actor recorded for decisions arriving through the AG-UI endpoint.
const AGUI_ACTOR: &str = "agui-client";

struct Follower {
    store: Arc<Store>,
    thread_id: String,
    cursor: i64,
    wake: watch::Receiver<i64>,
}

impl Follower {
    /// The wake receiver exists before the first read, so a commit between a
    /// read and the wait still ends the wait.
    async fn next_batch(&mut self) -> Option<Vec<ThreadEvent>> {
        loop {
            let batch = match self.store.events_after(&self.thread_id, self.cursor, BATCH) {
                Ok(batch) => batch,
                Err(error) => {
                    tracing::warn!(%error, "could not read the event log");
                    return None;
                }
            };
            if let Some(last) = batch.last() {
                self.cursor = last.seq;
                return Some(batch);
            }
            // A closed channel means the thread was deleted.
            self.wake.changed().await.ok()?;
        }
    }
}

fn follower(core: &Core, thread_id: &str, cursor: i64) -> Follower {
    let wake = core.store.hub().subscribe(thread_id);
    Follower {
        store: core.store.clone(),
        thread_id: thread_id.to_owned(),
        cursor,
        wake,
    }
}

fn log_frame(event: &ThreadEvent) -> Option<Result<Event, Infallible>> {
    match Event::default().id(event.seq.to_string()).json_data(event) {
        Ok(frame) => Some(Ok(frame)),
        Err(error) => {
            tracing::warn!(%error, "could not encode an event");
            None
        }
    }
}

pub async fn thread_events(
    State(state): State<AppState>,
    Path(id): Path<String>,
    headers: HeaderMap,
    query: QueryMap,
) -> ApiResult<Sse<impl Stream<Item = Result<Event, Infallible>>>> {
    state.core.store.thread(&id)?;
    let cursor = headers
        .get("last-event-id")
        .and_then(|value| value.to_str().ok())
        .or_else(|| query.get("after").map(String::as_str))
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let frames = stream::unfold(follower(&state.core, &id, cursor), |mut log| async move {
        let batch = log.next_batch().await?;
        Some((batch, log))
    })
    .flat_map(|batch| stream::iter(batch.iter().filter_map(log_frame).collect::<Vec<_>>()));
    Ok(Sse::new(frames).keep_alive(KeepAlive::new().interval(KEEP_ALIVE)))
}

/// Projects the thread log onto one external AG-UI run. A paused CLI stays alive
/// here, so a pending approval ends the external run with an interrupt while the
/// engine holds, and `resume[]` picks the same engine run back up.
struct Projection {
    log: Follower,
    run_id: String,
    outgoing: VecDeque<Value>,
    finished: bool,
}

impl Projection {
    fn project(&mut self, event: &ThreadEvent) {
        match &event.event {
            AgUiEvent::RunStarted { .. } => {}
            AgUiEvent::TextMessageStart { message_id, .. }
            | AgUiEvent::TextMessageContent { message_id, .. }
            | AgUiEvent::TextMessageEnd { message_id }
                if message_id.ends_with(":prompt") => {}
            AgUiEvent::RunFinished { outcome, .. } => {
                self.finish(json!({
                    "type": "RUN_FINISHED",
                    "threadId": self.log.thread_id,
                    "runId": self.run_id,
                    "outcome": outcome,
                }));
            }
            AgUiEvent::RunError { .. } => {
                if let Ok(frame) = serde_json::to_value(&event.event) {
                    self.finish(frame);
                }
            }
            AgUiEvent::ActivitySnapshot {
                activity_type,
                content,
                ..
            } if activity_type == "approval"
                && content.get("state") == Some(&json!(ApprovalState::Pending)) =>
            {
                let interrupts = self.open_interrupts();
                if interrupts.is_empty() {
                    self.forward(&event.event);
                } else {
                    self.finish(json!({
                        "type": "RUN_FINISHED",
                        "threadId": self.log.thread_id,
                        "runId": self.run_id,
                        "outcome": { "type": "interrupt", "interrupts": interrupts },
                    }));
                }
            }
            other => self.forward(other),
        }
    }

    fn forward(&mut self, event: &AgUiEvent) {
        if let Ok(frame) = serde_json::to_value(event) {
            self.outgoing.push_back(frame);
        }
    }

    fn finish(&mut self, frame: Value) {
        self.outgoing.push_back(frame);
        self.finished = true;
    }

    fn open_interrupts(&self) -> Vec<Value> {
        let pending = self
            .log
            .store
            .pending_for_thread(&self.log.thread_id)
            .unwrap_or_default();
        pending
            .into_iter()
            .map(|approval| {
                json!({
                    "id": approval.id,
                    "reason": "tool_approval",
                    "message": approval.summary,
                    "metadata": { "kind": approval.kind, "detail": approval.detail },
                })
            })
            .collect()
    }

    async fn next_frame(&mut self) -> Option<Value> {
        loop {
            if let Some(frame) = self.outgoing.pop_front() {
                return Some(frame);
            }
            if self.finished {
                return None;
            }
            for event in self.log.next_batch().await? {
                if self.finished {
                    break;
                }
                self.project(&event);
            }
        }
    }
}

fn run_error(message: &str, code: &str) -> Value {
    json!({ "type": "RUN_ERROR", "message": message, "code": code })
}

fn sse_of(frames: impl Stream<Item = Value> + Send + 'static) -> Response {
    let frames = frames.map(|frame| Ok::<_, Infallible>(Event::default().data(frame.to_string())));
    Sse::new(frames)
        .keep_alive(KeepAlive::new().interval(KEEP_ALIVE))
        .into_response()
}

fn prompt_of(input: &Value) -> Option<String> {
    let message = input
        .get("messages")?
        .as_array()?
        .iter()
        .rev()
        .find(|message| message.get("role").and_then(Value::as_str) == Some("user"))?;
    match message.get("content")? {
        Value::String(text) => Some(text.clone()),
        Value::Array(parts) => {
            let text: Vec<&str> = parts
                .iter()
                .filter_map(|part| part.get("text").and_then(Value::as_str))
                .collect();
            (!text.is_empty()).then(|| text.join("\n"))
        }
        _ => None,
    }
}

/// Applies `resume[]` and returns the log position to continue from.
fn apply_resume(core: &Core, thread_id: &str, resume: &[Value]) -> Result<i64, String> {
    let open = core
        .store
        .pending_for_thread(thread_id)
        .map_err(|error| error.public_message())?;
    let answers = |id: &str| {
        resume
            .iter()
            .any(|entry| entry.get("interruptId").and_then(Value::as_str) == Some(id))
    };
    if !open.iter().all(|approval| answers(&approval.id)) {
        return Err("A resume must answer every open interrupt.".into());
    }
    let mut cursor = 0;
    for entry in resume {
        let id = entry
            .get("interruptId")
            .and_then(Value::as_str)
            .ok_or_else(|| "A resume entry has no interruptId.".to_owned())?;
        let approval = core
            .store
            .approval(id)
            .map_err(|error| error.public_message())?;
        if approval.thread_id != thread_id {
            return Err("That interrupt belongs to another thread.".into());
        }
        let resolved = entry.get("status").and_then(Value::as_str) == Some("resolved");
        let allow = resolved && entry.pointer("/payload/approved") == Some(&Value::Bool(true));
        match core.gate.decide(id, allow, false, AGUI_ACTOR) {
            // A repeated resume is safe to replay.
            Ok(_) | Err(CoreError::AlreadyDecided(_)) => {}
            Err(error) => return Err(error.public_message()),
        }
        let (_, seq) = core
            .store
            .approval_position(id)
            .map_err(|error| error.public_message())?;
        cursor = cursor.max(seq);
    }
    Ok(cursor)
}

/// `POST /agui/threads/:id`.
pub async fn agui_run(
    State(state): State<AppState>,
    Path(id): Path<String>,
    ApiJson(input): ApiJson<Value>,
) -> ApiResult<Response> {
    let core = state.core.clone();
    core.store.thread(&id)?;
    if input.get("threadId").and_then(Value::as_str) != Some(id.as_str()) {
        return Err(CoreError::Invalid("threadId does not match this thread.".into()).into());
    }
    let run_id = input
        .get("runId")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::Invalid("runId is required.".into()))?
        .to_owned();
    let started = json!({ "type": "RUN_STARTED", "threadId": id, "runId": run_id });
    // Subscribed first, so nothing committed during admission is missed.
    let wake = core.store.hub().subscribe(&id);

    let cursor = match input.get("resume").and_then(Value::as_array) {
        Some(resume) if !resume.is_empty() => apply_resume(&core, &id, resume),
        _ => admit(&core, &id, &input),
    };
    let cursor = match cursor {
        Ok(cursor) => cursor,
        Err(message) => {
            let frames = vec![started, run_error(&message, "rejected")];
            return Ok(sse_of(stream::iter(frames)));
        }
    };
    let projection = Projection {
        log: Follower {
            store: core.store.clone(),
            thread_id: id,
            cursor,
            wake,
        },
        run_id,
        outgoing: VecDeque::from([started]),
        finished: false,
    };
    let frames = stream::unfold(projection, |mut projection| async move {
        let frame = projection.next_frame().await?;
        Some((frame, projection))
    });
    Ok(sse_of(frames))
}

fn admit(core: &Arc<Core>, thread_id: &str, input: &Value) -> Result<i64, String> {
    let open = core
        .store
        .pending_for_thread(thread_id)
        .map_err(|error| error.public_message())?;
    if !open.is_empty() {
        return Err("This thread has open interrupts. Resume them first.".into());
    }
    let prompt =
        prompt_of(input).ok_or_else(|| "The input has no user message to run.".to_owned())?;
    let cursor = core
        .store
        .latest_seq(thread_id)
        .map_err(|error| error.public_message())?;
    core.runs
        .admit(thread_id, &prompt, AGUI_ACTOR)
        .map_err(|error| error.public_message())?;
    Ok(cursor)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_is_the_last_user_message_in_either_shape() {
        let input = json!({ "messages": [
            { "role": "user", "content": "first" },
            { "role": "assistant", "content": "x" },
            { "role": "user", "content": [{ "type": "text", "text": "second" }] },
        ]});
        assert_eq!(prompt_of(&input).as_deref(), Some("second"));
        assert_eq!(prompt_of(&json!({ "messages": [] })), None);
    }
}
