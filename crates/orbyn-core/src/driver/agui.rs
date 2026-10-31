//! One driver for any AG-UI 1.0 agent, which is also the OpenBot connector.
//! Interrupts end a remote run, so the driver turns each into an approval and
//! continues with a new run carrying `resume[]`.

use std::collections::HashSet;
use std::time::Duration;

use async_trait::async_trait;
use futures_util::StreamExt;
use orbyn_contracts::{
    ActionKind, AgUiEvent, AuthState, CustomEngine, EngineCapabilities, EngineTier, SkillDelivery,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::{
    EngineDescriptor, EngineDriver, EngineEvent, EngineOutcome, EngineProbe, RunHandle, RunSpec,
    ask,
};
use crate::error::{CoreError, Result};
use crate::sse::SseParser;
use crate::util::new_id;

const PROTOCOL_VERSION: &str = "1.0";
/// Bounds a loop of interrupts from a misbehaving agent.
const MAX_RESUMES: usize = 100;

pub struct AguiDriver {
    engine: CustomEngine,
    client: reqwest::Client,
}

impl AguiDriver {
    pub fn new(engine: CustomEngine, client: reqwest::Client) -> Self {
        Self { engine, client }
    }
}

#[async_trait]
impl EngineDriver for AguiDriver {
    fn descriptor(&self) -> EngineDescriptor {
        EngineDescriptor {
            id: self.engine.id.clone(),
            name: self.engine.name.clone(),
            tier: EngineTier::Agui,
            capabilities: EngineCapabilities {
                streaming: true,
                approvals: true,
                resume: true,
                mcp: false,
                sandbox: false,
                managed: true,
                skill_delivery: vec![SkillDelivery::PromptBootstrap],
                goal_control: false,
                decline_feedback: false,
            },
        }
    }

    async fn probe(&self) -> EngineProbe {
        let reachable = self
            .client
            .head(&self.engine.target)
            .timeout(Duration::from_secs(3))
            .send()
            .await
            .is_ok();
        EngineProbe {
            path: Some(self.engine.target.clone().into()),
            auth: Some(AuthState::NotApplicable),
            problem: (!reachable).then(|| "The agent endpoint did not answer.".to_owned()),
            ..EngineProbe::default()
        }
    }

    async fn start_run(
        &self,
        spec: RunSpec,
        events: mpsc::Sender<EngineEvent>,
    ) -> Result<RunHandle> {
        let cancel = CancellationToken::new();
        let task = tokio::spawn(run_protocol(
            self.client.clone(),
            self.engine.target.clone(),
            spec,
            events,
            cancel.clone(),
        ));
        Ok(RunHandle {
            cancel,
            task,
            input: None,
        })
    }
}

async fn run_protocol(
    client: reqwest::Client,
    url: String,
    spec: RunSpec,
    events: mpsc::Sender<EngineEvent>,
    cancel: CancellationToken,
) {
    let outcome = tokio::select! {
        biased;
        () = cancel.cancelled() => EngineOutcome::Cancelled,
        outcome = drive(&client, &url, &spec, &events) => outcome,
    };
    let _ = events.send(EngineEvent::Finished(outcome)).await;
}

async fn drive(
    client: &reqwest::Client,
    url: &str,
    spec: &RunSpec,
    events: &mpsc::Sender<EngineEvent>,
) -> EngineOutcome {
    let text = spec.prompt.clone();
    let mut resume: Vec<Value> = Vec::new();
    let mut mapper = FrameMapper::default();
    for _ in 0..MAX_RESUMES {
        let input = run_input(spec, &text, &resume);
        match stream_run(client, url, &input, events, &mut mapper).await {
            Ok(RemoteEnd::Finished(outcome)) => return outcome,
            Ok(RemoteEnd::Interrupted(interrupts)) => {
                resume = answer_interrupts(interrupts, events).await;
            }
            Err(error) => return EngineOutcome::Failed(error.to_string()),
        }
    }
    EngineOutcome::Failed("The agent kept interrupting without finishing.".to_owned())
}

fn run_input(spec: &RunSpec, text: &str, resume: &[Value]) -> Value {
    let messages = if resume.is_empty() {
        json!([{ "id": new_id(), "role": "user", "content": text }])
    } else {
        json!([])
    };
    let mut input = json!({
        "protocolVersion": PROTOCOL_VERSION,
        "threadId": spec.thread_id,
        "runId": new_id(),
        "state": {},
        "messages": messages,
        "tools": [],
        "context": [],
        "forwardedProps": {},
    });
    if !resume.is_empty() {
        input["resume"] = json!(resume);
    }
    input
}

enum RemoteEnd {
    Finished(EngineOutcome),
    Interrupted(Vec<Value>),
}

async fn stream_run(
    client: &reqwest::Client,
    url: &str,
    input: &Value,
    events: &mpsc::Sender<EngineEvent>,
    mapper: &mut FrameMapper,
) -> Result<RemoteEnd> {
    let response = client
        .post(url)
        .header("Accept", "text/event-stream")
        .json(input)
        .send()
        .await
        .map_err(|error| CoreError::EngineUnavailable(format!("Could not reach agent: {error}")))?;
    if !response.status().is_success() {
        return Err(CoreError::EngineUnavailable(format!(
            "The agent answered {}.",
            response.status()
        )));
    }
    let mut body = response.bytes_stream();
    let mut parser = SseParser::default();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|error| {
            CoreError::EngineUnavailable(format!("Agent stream failed: {error}"))
        })?;
        for frame in parser.push(&chunk) {
            let Ok(value) = serde_json::from_str::<Value>(&frame) else {
                tracing::debug!("skipping a non-JSON AG-UI frame");
                continue;
            };
            match mapper.on_frame(value) {
                Mapped::Forward(forward) => {
                    for event in forward {
                        events
                            .send(event.into())
                            .await
                            .map_err(|_| CoreError::RunClosed)?;
                    }
                }
                Mapped::End(end) => return Ok(end),
                Mapped::Nothing => {}
            }
        }
    }
    Err(CoreError::EngineUnavailable(
        "The agent's stream ended before the run finished.".into(),
    ))
}

/// Each interrupt becomes a governed approval. Denial travels in the payload,
/// as the protocol specifies.
async fn answer_interrupts(
    interrupts: Vec<Value>,
    events: &mpsc::Sender<EngineEvent>,
) -> Vec<Value> {
    let mut resume = Vec::with_capacity(interrupts.len());
    for interrupt in interrupts {
        let id = interrupt
            .get("id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let reason = interrupt
            .get("reason")
            .and_then(Value::as_str)
            .unwrap_or("interrupt");
        let target = interrupt
            .get("toolCallId")
            .and_then(Value::as_str)
            .map_or_else(|| reason.to_owned(), str::to_owned);
        let summary = interrupt
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or(reason)
            .to_owned();
        let verdict = ask(events, ActionKind::Tool, target, summary, interrupt.clone()).await;
        resume.push(json!({
            "interruptId": id,
            "status": "resolved",
            "payload": { "approved": verdict.is_allowed() },
        }));
    }
    resume
}

enum Mapped {
    Forward(Vec<AgUiEvent>),
    End(RemoteEnd),
    Nothing,
}

/// Normalizes AG-UI frames for the log. Run lifecycle events end here because
/// the run manager owns those; anything not in the wire subset passes as `RAW`.
#[derive(Default)]
struct FrameMapper {
    open_text: HashSet<String>,
}

impl FrameMapper {
    fn on_frame(&mut self, mut frame: Value) -> Mapped {
        let kind = frame
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        match kind.as_str() {
            "RUN_STARTED" => Mapped::Nothing,
            "RUN_FINISHED" => {
                let outcome = frame.get("outcome").cloned().unwrap_or(Value::Null);
                Mapped::End(match outcome.get("type").and_then(Value::as_str) {
                    Some("interrupt") => RemoteEnd::Interrupted(
                        outcome
                            .get("interrupts")
                            .and_then(Value::as_array)
                            .cloned()
                            .unwrap_or_default(),
                    ),
                    Some("cancelled") => RemoteEnd::Finished(EngineOutcome::Cancelled),
                    _ => RemoteEnd::Finished(EngineOutcome::Completed),
                })
            }
            "RUN_ERROR" => Mapped::End(RemoteEnd::Finished(EngineOutcome::Failed(
                frame
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("The agent failed.")
                    .to_owned(),
            ))),
            "TEXT_MESSAGE_CHUNK" => self.on_chunk(&frame),
            _ => {
                if kind == "TEXT_MESSAGE_START" && frame.get("role").is_none() {
                    frame["role"] = json!("assistant");
                }
                if kind == "TOOL_CALL_RESULT"
                    && let Some(content) = frame.get("content").filter(|c| c.is_array())
                {
                    frame["content"] = Value::String(content.to_string());
                }
                let parsed = serde_json::from_value::<AgUiEvent>(frame.clone());
                Mapped::Forward(vec![parsed.unwrap_or(AgUiEvent::Raw {
                    event: frame,
                    source: Some("agui".into()),
                })])
            }
        }
    }

    fn on_chunk(&mut self, frame: &Value) -> Mapped {
        let Some(id) = frame.get("messageId").and_then(Value::as_str) else {
            return Mapped::Nothing;
        };
        let mut forward = Vec::new();
        if self.open_text.insert(id.to_owned()) {
            forward.push(AgUiEvent::TextMessageStart {
                message_id: id.to_owned(),
                role: frame
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or("assistant")
                    .to_owned(),
            });
        }
        if let Some(delta) = frame.get("delta").and_then(Value::as_str) {
            forward.push(AgUiEvent::TextMessageContent {
                message_id: id.to_owned(),
                delta: delta.to_owned(),
            });
        }
        Mapped::Forward(forward)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn forward(mapped: Mapped) -> Vec<AgUiEvent> {
        match mapped {
            Mapped::Forward(events) => events,
            _ => panic!("expected forwarded events"),
        }
    }

    #[test]
    fn absent_role_means_assistant() {
        let mut mapper = FrameMapper::default();
        let events = forward(mapper.on_frame(json!({"type":"TEXT_MESSAGE_START","messageId":"m"})));
        assert_eq!(
            events,
            [AgUiEvent::TextMessageStart {
                message_id: "m".into(),
                role: "assistant".into()
            }]
        );
    }

    #[test]
    fn events_outside_the_subset_stay_visible_as_raw() {
        let mut mapper = FrameMapper::default();
        let frame = json!({"type":"STATE_SNAPSHOT","snapshot":{}});
        assert!(matches!(
            forward(mapper.on_frame(frame))[0],
            AgUiEvent::Raw { .. }
        ));
    }

    #[test]
    fn chunks_open_their_message_once() {
        let mut mapper = FrameMapper::default();
        let frame = json!({"type":"TEXT_MESSAGE_CHUNK","messageId":"m","delta":"a"});
        assert_eq!(forward(mapper.on_frame(frame.clone())).len(), 2);
        assert_eq!(forward(mapper.on_frame(frame)).len(), 1);
    }

    #[test]
    fn interrupt_outcome_ends_the_remote_run() {
        let mut mapper = FrameMapper::default();
        let mapped = mapper.on_frame(json!({
            "type":"RUN_FINISHED","threadId":"t","runId":"r",
            "outcome":{"type":"interrupt","interrupts":[{"id":"i","reason":"tool_approval"}]}
        }));
        assert!(matches!(
            mapped,
            Mapped::End(RemoteEnd::Interrupted(interrupts)) if interrupts.len() == 1
        ));
    }

    #[test]
    fn legacy_finish_without_outcome_is_success() {
        let mut mapper = FrameMapper::default();
        let mapped = mapper.on_frame(json!({"type":"RUN_FINISHED","threadId":"t","runId":"r"}));
        assert!(matches!(
            mapped,
            Mapped::End(RemoteEnd::Finished(EngineOutcome::Completed))
        ));
    }
}
