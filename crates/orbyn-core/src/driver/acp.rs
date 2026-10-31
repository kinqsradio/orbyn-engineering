//! One driver for any Agent Client Protocol agent: JSON-RPC 2.0 over stdio,
//! protocol version 1. The client advertises no file or terminal methods, so an
//! agent cannot act through Orbyn without asking.

use std::collections::HashSet;
use std::ffi::OsString;
use std::time::Duration;

use async_trait::async_trait;
use orbyn_contracts::{
    ActionKind, AgUiEvent, AuthState, CustomEngine, EngineCapabilities, EngineTier, SkillDelivery,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::pipes::{EngineProcess, exit_message, resolve_engine, spawn_engine};
use super::rpc::{Inbound, RpcClient};
use super::{
    EngineDescriptor, EngineDriver, EngineEvent, EngineOutcome, EngineProbe, MCP_SERVER_NAME,
    RunHandle, RunSpec, ask,
};
use crate::approvals::Verdict;
use crate::error::{CoreError, Result};
use crate::util::new_id;

const PROTOCOL_VERSION: u64 = 1;
const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const PROMPT_TIMEOUT: Duration = Duration::from_secs(24 * 60 * 60);
const CANCEL_GRACE: Duration = Duration::from_secs(5);
const METHOD_NOT_FOUND: i64 = -32601;

pub struct AcpDriver {
    engine: CustomEngine,
}

impl AcpDriver {
    pub fn new(engine: CustomEngine) -> Self {
        Self { engine }
    }
}

#[async_trait]
impl EngineDriver for AcpDriver {
    fn descriptor(&self) -> EngineDescriptor {
        EngineDescriptor {
            id: self.engine.id.clone(),
            name: self.engine.name.clone(),
            tier: EngineTier::Acp,
            capabilities: EngineCapabilities {
                streaming: true,
                approvals: true,
                resume: false,
                mcp: true,
                sandbox: false,
                managed: true,
                skill_delivery: vec![
                    SkillDelivery::McpSkillServer,
                    SkillDelivery::PromptBootstrap,
                ],
            },
        }
    }

    async fn probe(&self) -> EngineProbe {
        EngineProbe {
            path: crate::process::resolve(&self.engine.target).map(|command| command.path),
            auth: Some(AuthState::NotApplicable),
            ..EngineProbe::default()
        }
    }

    async fn start_run(
        &self,
        spec: RunSpec,
        events: mpsc::Sender<EngineEvent>,
    ) -> Result<RunHandle> {
        let command = resolve_engine(&self.engine.target)?;
        let args: Vec<OsString> = self.engine.args.iter().map(OsString::from).collect();
        let process = spawn_engine(&command, &args, &spec.cwd)?;
        let cancel = CancellationToken::new();
        let task = tokio::spawn(run_protocol(process, spec, events, cancel.clone()));
        Ok(RunHandle { cancel, task })
    }
}

async fn run_protocol(
    mut process: EngineProcess,
    spec: RunSpec,
    events: mpsc::Sender<EngineEvent>,
    cancel: CancellationToken,
) {
    let (rpc, mut inbound) = RpcClient::start(process.stdin, process.stdout, true);
    let opened = tokio::select! {
        biased;
        () = cancel.cancelled() => Err(CoreError::RunClosed),
        result = open_session(&rpc, &spec) => result,
    };
    let session = match opened {
        Ok(session) => session,
        Err(error) => {
            let outcome = if cancel.is_cancelled() {
                EngineOutcome::Cancelled
            } else {
                EngineOutcome::Failed(error.to_string())
            };
            let _ = events.send(EngineEvent::Finished(outcome)).await;
            return;
        }
    };
    let prompt_text = match &spec.skills.bootstrap {
        Some(bootstrap) => format!("{bootstrap}\n\n{}", spec.prompt),
        None => spec.prompt.clone(),
    };
    let prompt_call = rpc.call(
        "session/prompt",
        json!({ "sessionId": session, "prompt": [{ "type": "text", "text": prompt_text }] }),
        PROMPT_TIMEOUT,
    );
    tokio::pin!(prompt_call);
    let mut mapper = UpdateMapper::default();
    let mut cancel_sent = false;
    let outcome = loop {
        tokio::select! {
            biased;
            () = cancel.cancelled(), if !cancel_sent => {
                cancel_sent = true;
                let _ = rpc
                    .notify("session/cancel", Some(json!({ "sessionId": session })))
                    .await;
            }
            () = tokio::time::sleep(CANCEL_GRACE), if cancel_sent => {
                break EngineOutcome::Cancelled;
            }
            message = inbound.recv() => {
                match message {
                    Some(Inbound::Notification { method, params }) => {
                        if method == "session/update" {
                            for event in mapper.on_update(params.get("update").unwrap_or(&Value::Null)) {
                                if events.send(event).await.is_err() {
                                    return;
                                }
                            }
                        }
                    }
                    Some(Inbound::Request { id, method, params }) => {
                        answer_request(&rpc, &events, &cancel, id, method, params);
                    }
                    None => {
                        if cancel.is_cancelled() {
                            break EngineOutcome::Cancelled;
                        }
                        let status = tokio::time::timeout(CANCEL_GRACE, process.child.wait()).await;
                        let status = status.ok().and_then(Result::ok);
                        break EngineOutcome::Failed(exit_message(status, &process.stderr));
                    }
                }
            }
            result = &mut prompt_call => {
                // Updates sent before the reply are already queued; drain them.
                while let Ok(message) = inbound.try_recv() {
                    if let Inbound::Notification { method, params } = message
                        && method == "session/update"
                    {
                        for event in mapper.on_update(params.get("update").unwrap_or(&Value::Null)) {
                            let _ = events.send(event).await;
                        }
                    }
                }
                break match result {
                    Ok(reply) => stop_outcome(&reply),
                    Err(error) => EngineOutcome::Failed(error.to_string()),
                };
            }
        }
    };
    for event in mapper.close() {
        let _ = events.send(event).await;
    }
    let outcome = if cancel.is_cancelled() {
        EngineOutcome::Cancelled
    } else {
        outcome
    };
    let _ = events.send(EngineEvent::Finished(outcome)).await;
}

async fn open_session(rpc: &RpcClient, spec: &RunSpec) -> Result<String> {
    let init = rpc
        .call(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "clientInfo": { "name": "orbyn", "version": env!("CARGO_PKG_VERSION") },
                "clientCapabilities": {
                    "fs": { "readTextFile": false, "writeTextFile": false },
                    "terminal": false,
                },
            }),
            CALL_TIMEOUT,
        )
        .await?;
    let version = init.get("protocolVersion").and_then(Value::as_u64);
    if version != Some(PROTOCOL_VERSION) {
        return Err(CoreError::EngineUnavailable(format!(
            "This agent speaks ACP {}, and Orbyn speaks version {PROTOCOL_VERSION}.",
            version.map_or_else(|| "of an unknown version".to_owned(), |v| v.to_string())
        )));
    }
    let http_mcp = init
        .pointer("/agentCapabilities/mcpCapabilities/http")
        .and_then(Value::as_bool)
        == Some(true);
    let servers = match &spec.mcp_url {
        Some(url) if http_mcp => {
            json!([{ "type": "http", "name": MCP_SERVER_NAME, "url": url, "headers": [] }])
        }
        _ => json!([]),
    };
    let session = rpc
        .call(
            "session/new",
            json!({ "cwd": spec.cwd, "mcpServers": servers }),
            CALL_TIMEOUT,
        )
        .await?;
    session
        .get("sessionId")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| CoreError::EngineUnavailable("The agent returned no session id.".into()))
}

fn stop_outcome(reply: &Value) -> EngineOutcome {
    match reply.get("stopReason").and_then(Value::as_str) {
        Some("end_turn") => EngineOutcome::Completed,
        Some("cancelled") => EngineOutcome::Cancelled,
        Some(reason) => EngineOutcome::Failed(format!("The agent stopped: {reason}.")),
        None => EngineOutcome::Completed,
    }
}

fn answer_request(
    rpc: &RpcClient,
    events: &mpsc::Sender<EngineEvent>,
    cancel: &CancellationToken,
    id: Value,
    method: String,
    params: Value,
) {
    let rpc = rpc.clone();
    if method != "session/request_permission" {
        tokio::spawn(async move {
            let text = format!("Orbyn does not serve {method}.");
            let _ = rpc.respond_error(id, METHOD_NOT_FOUND, &text).await;
        });
        return;
    }
    let events = events.clone();
    let cancel = cancel.clone();
    tokio::spawn(async move {
        let (kind, target, summary) = classify(&params);
        let verdict = ask(&events, kind, target, summary, params.clone()).await;
        let outcome = permission_outcome(&params, &verdict, cancel.is_cancelled());
        let _ = rpc.respond(id, json!({ "outcome": outcome })).await;
    });
}

/// Picks the option that matches the verdict. Fails closed: with no matching
/// option the request is reported cancelled, never allowed.
fn permission_outcome(params: &Value, verdict: &Verdict, cancelled: bool) -> Value {
    if cancelled {
        return json!({ "outcome": "cancelled" });
    }
    let wanted: &[&str] = if verdict.is_allowed() {
        &["allow_once", "allow_always"]
    } else {
        &["reject_once", "reject_always"]
    };
    let options = params
        .get("options")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    wanted
        .iter()
        .find_map(|kind| {
            options
                .iter()
                .find(|option| option.get("kind").and_then(Value::as_str) == Some(kind))
        })
        .and_then(|option| option.get("optionId").and_then(Value::as_str))
        .map_or_else(
            || json!({ "outcome": "cancelled" }),
            |id| json!({ "outcome": "selected", "optionId": id }),
        )
}

fn classify(params: &Value) -> (ActionKind, String, String) {
    let call = params.get("toolCall").cloned().unwrap_or(Value::Null);
    let title = call
        .get("title")
        .or_else(|| params.get("title"))
        .and_then(Value::as_str)
        .unwrap_or("Agent action")
        .to_owned();
    let path = call
        .pointer("/locations/0/path")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let command = call
        .pointer("/rawInput/command")
        .and_then(Value::as_str)
        .map(str::to_owned);
    match call.get("kind").and_then(Value::as_str) {
        Some("execute") => (
            ActionKind::Command,
            command.unwrap_or_else(|| title.clone()),
            title,
        ),
        Some("edit" | "delete" | "move") => (
            ActionKind::FileChange,
            path.unwrap_or_else(|| title.clone()),
            title,
        ),
        Some("fetch" | "search") => (ActionKind::Network, title.clone(), title),
        _ => (ActionKind::Tool, title.clone(), title),
    }
}

/// Maps `session/update` payloads. Chunks of one kind form one message, which
/// closes when another kind of update arrives.
#[derive(Default)]
struct UpdateMapper {
    text: Option<String>,
    reasoning: Option<String>,
    tools: HashSet<String>,
}

impl UpdateMapper {
    fn on_update(&mut self, update: &Value) -> Vec<EngineEvent> {
        let mut events = Vec::new();
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                self.close_reasoning(&mut events);
                let delta = chunk_text(update);
                let id = self.text.get_or_insert_with(new_id).clone();
                if !self.tools.contains(&format!("open:{id}")) {
                    self.tools.insert(format!("open:{id}"));
                    events.push(
                        AgUiEvent::TextMessageStart {
                            message_id: id.clone(),
                            role: "assistant".into(),
                        }
                        .into(),
                    );
                }
                events.push(
                    AgUiEvent::TextMessageContent {
                        message_id: id,
                        delta,
                    }
                    .into(),
                );
            }
            Some("agent_thought_chunk") => {
                self.close_text(&mut events);
                let delta = chunk_text(update);
                let id = self.reasoning.get_or_insert_with(new_id).clone();
                if !self.tools.contains(&format!("open:{id}")) {
                    self.tools.insert(format!("open:{id}"));
                    events.push(
                        AgUiEvent::ReasoningMessageStart {
                            message_id: id.clone(),
                            role: "reasoning".into(),
                        }
                        .into(),
                    );
                }
                events.push(
                    AgUiEvent::ReasoningMessageContent {
                        message_id: id,
                        delta,
                    }
                    .into(),
                );
            }
            Some("tool_call") => {
                self.close_text(&mut events);
                self.close_reasoning(&mut events);
                let id = field(update, "toolCallId");
                self.tools.insert(id.clone());
                events.push(
                    AgUiEvent::ToolCallStart {
                        tool_call_id: id.clone(),
                        tool_call_name: field(update, "title"),
                    }
                    .into(),
                );
                if let Some(input) = update.get("rawInput") {
                    events.push(
                        AgUiEvent::ToolCallArgs {
                            tool_call_id: id,
                            delta: input.to_string(),
                        }
                        .into(),
                    );
                }
            }
            Some("tool_call_update") => {
                let id = field(update, "toolCallId");
                let status = update.get("status").and_then(Value::as_str);
                if matches!(status, Some("completed" | "failed")) && self.tools.remove(&id) {
                    events.push(
                        AgUiEvent::ToolCallEnd {
                            tool_call_id: id.clone(),
                        }
                        .into(),
                    );
                    events.push(
                        AgUiEvent::ToolCallResult {
                            message_id: new_id(),
                            tool_call_id: id,
                            content: tool_output(update),
                            role: Some("tool".into()),
                        }
                        .into(),
                    );
                }
            }
            Some("plan") => {
                let steps: Vec<Value> = update
                    .get("entries")
                    .and_then(Value::as_array)
                    .map(|entries| {
                        entries
                            .iter()
                            .map(|entry| {
                                json!({
                                    "title": field(entry, "content"),
                                    "status": field(entry, "status"),
                                })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                events.push(
                    AgUiEvent::ActivitySnapshot {
                        message_id: "plan".into(),
                        activity_type: "plan".into(),
                        content: json!({ "steps": steps }),
                        replace: Some(true),
                    }
                    .into(),
                );
            }
            _ => {}
        }
        events
    }

    fn close_text(&mut self, events: &mut Vec<EngineEvent>) {
        if let Some(id) = self.text.take() {
            self.tools.remove(&format!("open:{id}"));
            events.push(AgUiEvent::TextMessageEnd { message_id: id }.into());
        }
    }

    fn close_reasoning(&mut self, events: &mut Vec<EngineEvent>) {
        if let Some(id) = self.reasoning.take() {
            self.tools.remove(&format!("open:{id}"));
            events.push(AgUiEvent::ReasoningMessageEnd { message_id: id }.into());
        }
    }

    fn close(&mut self) -> Vec<EngineEvent> {
        let mut events = Vec::new();
        self.close_text(&mut events);
        self.close_reasoning(&mut events);
        for id in self.tools.drain() {
            events.push(AgUiEvent::ToolCallEnd { tool_call_id: id }.into());
        }
        events
    }
}

fn chunk_text(update: &Value) -> String {
    update
        .pointer("/content/text")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn field(value: &Value, key: &str) -> String {
    value
        .get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned()
}

fn tool_output(update: &Value) -> String {
    if let Some(output) = update.get("rawOutput") {
        return match output {
            Value::String(text) => text.clone(),
            other => other.to_string(),
        };
    }
    update
        .get("content")
        .and_then(Value::as_array)
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part.pointer("/content/text").and_then(Value::as_str))
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn options() -> Value {
        json!({ "options": [
            { "optionId": "yes-always", "name": "Always", "kind": "allow_always" },
            { "optionId": "yes", "name": "Yes", "kind": "allow_once" },
            { "optionId": "no", "name": "No", "kind": "reject_once" },
        ]})
    }

    #[test]
    fn allow_picks_the_narrowest_grant() {
        assert_eq!(
            permission_outcome(&options(), &Verdict::Allow, false),
            json!({ "outcome": "selected", "optionId": "yes" })
        );
    }

    #[test]
    fn deny_picks_reject_and_missing_option_never_allows() {
        assert_eq!(
            permission_outcome(&options(), &Verdict::Deny("x".into()), false),
            json!({ "outcome": "selected", "optionId": "no" })
        );
        let only_allow = json!({ "options": [{ "optionId": "y", "kind": "allow_once" }] });
        assert_eq!(
            permission_outcome(&only_allow, &Verdict::Deny("x".into()), false),
            json!({ "outcome": "cancelled" })
        );
    }

    #[test]
    fn cancellation_answers_cancelled() {
        assert_eq!(
            permission_outcome(&options(), &Verdict::Allow, true),
            json!({ "outcome": "cancelled" })
        );
    }

    #[test]
    fn chunks_form_one_message_until_the_kind_changes() {
        let mut mapper = UpdateMapper::default();
        let chunk = json!({ "sessionUpdate": "agent_message_chunk", "content": { "type": "text", "text": "a" } });
        assert_eq!(mapper.on_update(&chunk).len(), 2);
        assert_eq!(mapper.on_update(&chunk).len(), 1);
        let tool = json!({ "sessionUpdate": "tool_call", "toolCallId": "c", "title": "ls" });
        assert_eq!(mapper.on_update(&tool).len(), 2);
        assert_eq!(mapper.close().len(), 1);
    }

    #[test]
    fn execute_targets_the_command_text() {
        let params = json!({ "toolCall": { "title": "List", "kind": "execute", "rawInput": { "command": "ls -a" } } });
        let (kind, target, _) = classify(&params);
        assert_eq!(kind, ActionKind::Command);
        assert_eq!(target, "ls -a");
    }
}
