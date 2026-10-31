//! Codex through `codex app-server`: JSONL over stdio, without the `jsonrpc`
//! header. Login stays Codex's own; this driver never calls `account/login/*`.

use std::collections::HashMap;
use std::ffi::OsString;
use std::time::Duration;

use async_trait::async_trait;
use orbyn_contracts::{
    ActionKind, AgUiEvent, AuthState, EngineCapabilities, EngineTier, SkillDelivery, ThreadUsage,
};
use serde_json::{Value, json};
use tokio::sync::mpsc;
use tokio_util::sync::CancellationToken;

use super::pipes::{EngineProcess, exit_message, one_shot_cli, resolve_engine, spawn_engine};
use super::rpc::{Inbound, RpcClient};
use super::{
    EngineDescriptor, EngineDriver, EngineEvent, EngineOutcome, EngineProbe, ItemRecord,
    MCP_SERVER_NAME, RunHandle, RunKind, RunSpec, UpdatePlan, ask_paths, diff_activity,
};
use crate::approvals::Verdict;
use crate::engines::maintenance;
use crate::engines::probe::{probe_cli, read_login};
use crate::error::{CoreError, Result};
use crate::util::new_id;

const CALL_TIMEOUT: Duration = Duration::from_secs(60);
const INTERRUPT_GRACE: Duration = Duration::from_secs(5);

/// JSON-RPC method-not-found, used to refuse server requests Orbyn does not serve.
const METHOD_NOT_FOUND: i64 = -32601;

pub struct CodexDriver {
    program: String,
    sandbox: String,
}

impl CodexDriver {
    /// `sandbox` is one of Codex's `SandboxMode` names.
    pub fn new(program: String, sandbox: String) -> Self {
        Self { program, sandbox }
    }
}

#[async_trait]
impl EngineDriver for CodexDriver {
    fn descriptor(&self) -> EngineDescriptor {
        EngineDescriptor {
            id: "codex".into(),
            name: "Codex".into(),
            tier: EngineTier::Native,
            capabilities: EngineCapabilities {
                streaming: true,
                approvals: true,
                resume: true,
                mcp: true,
                sandbox: true,
                managed: true,
                skill_delivery: vec![
                    SkillDelivery::NativeSkillRoot,
                    SkillDelivery::McpSkillServer,
                ],
            },
        }
    }

    async fn probe(&self) -> EngineProbe {
        let mut probe = probe_cli(&self.program, &["--version"]).await;
        if probe.path.is_some() {
            probe.auth = Some(read_login(&self.program, &["login", "status"], parse_login).await);
        }
        probe.sign_in_command = Some("codex login".into());
        probe
    }

    async fn update_plan(&self, probe: &EngineProbe) -> Option<UpdatePlan> {
        maintenance::plan_update(probe, &maintenance::CODEX).await
    }

    fn manual_hint(&self) -> Option<String> {
        Some("Update Codex with the installer you used, then refresh.".into())
    }

    fn npm_package(&self) -> Option<&str> {
        Some(maintenance::CODEX.npm_package)
    }

    async fn one_shot(&self, prompt: &str, model: Option<&str>) -> Result<String> {
        let mut args = vec![
            "exec",
            "--ephemeral",
            "--skip-git-repo-check",
            "--sandbox",
            "read-only",
            "--color",
            "never",
        ];
        if let Some(model) = model {
            args.extend(["--model", model]);
        }
        args.push("-");
        one_shot_cli(&self.program, &args, prompt).await
    }

    async fn start_run(
        &self,
        spec: RunSpec,
        events: mpsc::Sender<EngineEvent>,
    ) -> Result<RunHandle> {
        let command = resolve_engine(&self.program)?;
        let args = [OsString::from("app-server")];
        let process = spawn_engine(&command, &args, &spec.cwd)?;
        let cancel = CancellationToken::new();
        let (input, steering) = mpsc::unbounded_channel();
        let task = tokio::spawn(run_protocol(
            process,
            spec,
            self.sandbox.clone(),
            events,
            steering,
            cancel.clone(),
        ));
        Ok(RunHandle {
            cancel,
            task,
            input: Some(input),
        })
    }
}

fn parse_login(status: i32, stdout: &str) -> AuthState {
    if status == 0 && stdout.to_ascii_lowercase().contains("logged in") {
        AuthState::LoggedIn
    } else if status != 0 || stdout.to_ascii_lowercase().contains("not logged in") {
        AuthState::LoggedOut
    } else {
        AuthState::Unknown
    }
}

async fn run_protocol(
    mut process: EngineProcess,
    spec: RunSpec,
    sandbox: String,
    events: mpsc::Sender<EngineEvent>,
    mut steering: mpsc::UnboundedReceiver<String>,
    cancel: CancellationToken,
) {
    let (rpc, mut inbound) = RpcClient::start(process.stdin, process.stdout, false);
    let opened = tokio::select! {
        biased;
        () = cancel.cancelled() => Err(CoreError::RunClosed),
        result = open_turn(&rpc, &spec, &sandbox, &events) => result,
    };
    let (session, mut turn_id) = match opened {
        Ok(ids) => ids,
        Err(error) => {
            let outcome = if cancel.is_cancelled() {
                EngineOutcome::Cancelled
            } else {
                let status = tokio::time::timeout(EXIT_WAIT, process.child.wait()).await;
                let exited = status.ok().and_then(Result::ok);
                match exited {
                    Some(status) => {
                        EngineOutcome::Failed(exit_message(Some(status), &process.stderr).await)
                    }
                    None => EngineOutcome::Failed(error.to_string()),
                }
            };
            let _ = events.send(EngineEvent::Finished(outcome)).await;
            return;
        }
    };
    let mut mapper = TurnMapper::new(session.clone());
    let mut interrupted_at: Option<tokio::time::Instant> = None;
    let outcome = loop {
        let deadline = interrupted_at.map(|at| at + INTERRUPT_GRACE);
        tokio::select! {
            biased;
            () = cancel.cancelled(), if interrupted_at.is_none() => {
                interrupted_at = Some(tokio::time::Instant::now());
                if let Some(turn) = &turn_id {
                    let rpc = rpc.clone();
                    let params = json!({ "threadId": session, "turnId": turn });
                    tokio::spawn(async move {
                        let _ = rpc.call("turn/interrupt", params, INTERRUPT_GRACE).await;
                    });
                }
            }
            () = sleep_until(deadline), if deadline.is_some() => break EngineOutcome::Cancelled,
            Some(text) = steering.recv() => {
                if let Some(turn) = &turn_id {
                    let rpc = rpc.clone();
                    let params = json!({
                        "threadId": session,
                        "expectedTurnId": turn,
                        "input": [{ "type": "text", "text": text, "text_elements": [] }],
                    });
                    tokio::spawn(async move {
                        if let Err(error) = rpc.call("turn/steer", params, CALL_TIMEOUT).await {
                            tracing::debug!(%error, "could not steer the run");
                        }
                    });
                }
            }
            message = inbound.recv() => {
                let Some(message) = message else {
                    if interrupted_at.is_some() {
                        break EngineOutcome::Cancelled;
                    }
                    let status = tokio::time::timeout(EXIT_WAIT, process.child.wait()).await;
                    let status = status.ok().and_then(Result::ok);
                    break EngineOutcome::Failed(exit_message(status, &process.stderr).await);
                };
                match message {
                    Inbound::Notification { method, params } => {
                        if method == "turn/started"
                            && let Some(id) = params.pointer("/turn/id").and_then(Value::as_str)
                        {
                            turn_id.get_or_insert_with(|| id.to_owned());
                        }
                        let step = mapper.on_notification(&method, &params);
                        for event in step.events {
                            if events.send(event).await.is_err() {
                                return;
                            }
                        }
                        if let Some(outcome) = step.outcome {
                            break outcome;
                        }
                    }
                    Inbound::Request { id, method, params } => {
                        answer_request(&rpc, &events, &mapper, id, method, params);
                    }
                }
            }
        }
    };
    for event in mapper.close_open() {
        let _ = events.send(event).await;
    }
    let outcome = if cancel.is_cancelled() {
        EngineOutcome::Cancelled
    } else {
        outcome
    };
    let _ = events.send(EngineEvent::Finished(outcome)).await;
}

const EXIT_WAIT: Duration = Duration::from_secs(2);

async fn sleep_until(deadline: Option<tokio::time::Instant>) {
    match deadline {
        Some(deadline) => tokio::time::sleep_until(deadline).await,
        None => std::future::pending().await,
    }
}

/// Runs the handshake and starts the turn. Returns the Codex thread id and the
/// turn id when the response has already carried it.
async fn open_turn(
    rpc: &RpcClient,
    spec: &RunSpec,
    sandbox: &str,
    events: &mpsc::Sender<EngineEvent>,
) -> Result<(String, Option<String>)> {
    rpc.call(
        "initialize",
        json!({
            "clientInfo": {
                "name": "orbyn",
                "title": "Orbyn Engineering",
                "version": env!("CARGO_PKG_VERSION"),
            },
            "capabilities": { "experimentalApi": true },
        }),
        CALL_TIMEOUT,
    )
    .await?;
    rpc.notify("initialized", None).await?;
    let config = thread_config(spec);
    let mut params = json!({
        "cwd": spec.cwd,
        "approvalPolicy": "on-request",
        "sandbox": sandbox,
        "config": config,
    });
    if let Some(model) = &spec.model {
        params["model"] = json!(model);
    }
    let thread = match &spec.resume {
        Some(session) => {
            params["threadId"] = json!(session);
            rpc.call("thread/resume", params, CALL_TIMEOUT).await?
        }
        None => rpc.call("thread/start", params, CALL_TIMEOUT).await?,
    };
    let session = thread
        .pointer("/thread/id")
        .and_then(Value::as_str)
        .ok_or_else(|| CoreError::EngineUnavailable("Codex returned no thread id.".into()))?
        .to_owned();
    let _ = events.send(EngineEvent::Session(session.clone())).await;
    match &spec.kind {
        RunKind::Compact => {
            rpc.call(
                "thread/compact/start",
                json!({ "threadId": session }),
                CALL_TIMEOUT,
            )
            .await?;
            return Ok((session, None));
        }
        RunKind::Goal(objective) => {
            rpc.call(
                "thread/goal/set",
                json!({ "threadId": session, "objective": objective }),
                CALL_TIMEOUT,
            )
            .await?;
            if objective.is_none() {
                let _ = events
                    .send(EngineEvent::Finished(EngineOutcome::Completed))
                    .await;
                return Ok((session, None));
            }
        }
        RunKind::Turn => {}
    }
    let policy = if spec.plan { "read-only" } else { sandbox };
    let turn = rpc
        .call(
            "turn/start",
            json!({
                "threadId": session,
                "input": [{ "type": "text", "text": spec.prompt, "text_elements": [] }],
                "cwd": spec.checkout,
                "sandboxPolicy": sandbox_policy(policy, &spec.checkout),
            }),
            CALL_TIMEOUT,
        )
        .await?;
    let turn_id = turn
        .pointer("/turn/id")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok((session, turn_id))
}

/// Codex always lets a turn write to its own cwd. The thread therefore starts at
/// the workspace root, for native discovery, and each turn moves its cwd and
/// writable root to the selected checkout, keeping the library read-only.
fn sandbox_policy(sandbox: &str, checkout: &std::path::Path) -> Value {
    match sandbox {
        "read-only" => json!({ "type": "readOnly" }),
        "danger-full-access" => json!({ "type": "dangerFullAccess" }),
        _ => json!({ "type": "workspaceWrite", "writableRoots": [checkout] }),
    }
}

/// The per-run MCP server. Orbyn's tools carry their own policy gate, so Codex
/// does not ask a second time before calling them.
fn thread_config(spec: &RunSpec) -> Value {
    match &spec.mcp_url {
        Some(url) => json!({
            "mcp_servers": {
                (MCP_SERVER_NAME): { "url": url, "default_tools_approval_mode": "approve" }
            }
        }),
        None => json!({}),
    }
}

/// Answers one server request on its own task so the turn keeps flowing while a
/// person decides. Anything unrecognized is refused, never ignored.
fn answer_request(
    rpc: &RpcClient,
    events: &mpsc::Sender<EngineEvent>,
    mapper: &TurnMapper,
    id: Value,
    method: String,
    params: Value,
) {
    let rpc = rpc.clone();
    let Some(request) = classify_request(&method, &params, mapper) else {
        tracing::info!(%method, "refusing an unknown Codex server request");
        tokio::spawn(async move {
            let text = format!("Orbyn does not serve {method}.");
            let _ = rpc.respond_error(id, METHOD_NOT_FOUND, &text).await;
        });
        return;
    };
    let events = events.clone();
    tokio::spawn(async move {
        let verdict = ask_paths(
            &events,
            request.kind,
            request.target,
            request.summary,
            params.clone(),
            request.paths,
        )
        .await;
        let result = approval_response(&method, &params, &verdict);
        let _ = rpc.respond(id, result).await;
    });
}

struct ClassifiedRequest {
    kind: ActionKind,
    target: String,
    summary: String,
    paths: Vec<String>,
}

fn classify_request(
    method: &str,
    params: &Value,
    mapper: &TurnMapper,
) -> Option<ClassifiedRequest> {
    match method {
        "item/commandExecution/requestApproval" => {
            let target = params
                .get("command")
                .and_then(Value::as_str)
                .or_else(|| params.get("reason").and_then(Value::as_str))
                .unwrap_or("command")
                .to_owned();
            let network = params
                .get("networkApprovalContext")
                .is_some_and(|context| !context.is_null());
            Some(ClassifiedRequest {
                kind: if network {
                    ActionKind::Network
                } else {
                    ActionKind::Command
                },
                summary: format!("Run {target}"),
                target,
                paths: Vec::new(),
            })
        }
        "item/fileChange/requestApproval" => {
            let item = params.get("itemId").and_then(Value::as_str).unwrap_or("");
            let mut paths = mapper.file_paths.get(item).cloned().unwrap_or_default();
            paths.extend(text(params, "grantRoot"));
            let target = if paths.is_empty() {
                "file changes".to_owned()
            } else {
                paths.join(" ")
            };
            Some(ClassifiedRequest {
                kind: ActionKind::FileChange,
                summary: format!("Change {target}"),
                target,
                paths,
            })
        }
        "item/permissions/requestApproval" => {
            let network = params
                .pointer("/permissions/network")
                .is_some_and(|value| !value.is_null());
            let target = text(params, "reason")
                .or_else(|| text(params, "cwd"))
                .unwrap_or_else(|| "additional permissions".to_owned());
            Some(ClassifiedRequest {
                kind: if network {
                    ActionKind::Network
                } else {
                    ActionKind::Tool
                },
                summary: format!("Grant permissions: {target}"),
                target,
                paths: Vec::new(),
            })
        }
        "execCommandApproval" => {
            let target = params
                .get("command")
                .and_then(Value::as_array)
                .map(|parts| {
                    parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" ")
                })
                .unwrap_or_else(|| "command".to_owned());
            Some(ClassifiedRequest {
                kind: ActionKind::Command,
                summary: format!("Run {target}"),
                target,
                paths: Vec::new(),
            })
        }
        "applyPatchApproval" => {
            let paths: Vec<String> = params
                .get("fileChanges")
                .and_then(Value::as_object)
                .map(|changes| changes.keys().cloned().collect())
                .unwrap_or_default();
            let target = if paths.is_empty() {
                "file changes".to_owned()
            } else {
                paths.join(" ")
            };
            Some(ClassifiedRequest {
                kind: ActionKind::FileChange,
                summary: format!("Change {target}"),
                target,
                paths,
            })
        }
        _ => None,
    }
}

/// The response shape each approval method's schema requires.
fn approval_response(method: &str, params: &Value, verdict: &Verdict) -> Value {
    let allowed = verdict.is_allowed();
    match method {
        "item/permissions/requestApproval" => {
            if allowed {
                json!({
                    "permissions": params.get("permissions").cloned().unwrap_or(json!({})),
                    "scope": "turn",
                })
            } else {
                json!({ "permissions": {}, "scope": "turn" })
            }
        }
        "execCommandApproval" | "applyPatchApproval" => {
            json!({ "decision": if allowed { "approved" } else { "denied" } })
        }
        _ => json!({ "decision": if allowed { "accept" } else { "decline" } }),
    }
}

fn text(value: &Value, key: &str) -> Option<String> {
    value.get(key).and_then(Value::as_str).map(str::to_owned)
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ItemKind {
    Message,
    Reasoning,
    Tool,
}

#[derive(Default)]
struct Step {
    events: Vec<EngineEvent>,
    outcome: Option<EngineOutcome>,
}

/// Maps turn notifications to events. It tolerates a `completed` without a
/// `started`, and ignores other threads: Codex sub-agents share this stdio.
struct TurnMapper {
    session: String,
    open: HashMap<String, ItemKind>,
    delivered_text: HashMap<String, bool>,
    file_paths: HashMap<String, Vec<String>>,
    last_error: Option<String>,
}

impl TurnMapper {
    fn new(session: String) -> Self {
        Self {
            session,
            open: HashMap::new(),
            delivered_text: HashMap::new(),
            file_paths: HashMap::new(),
            last_error: None,
        }
    }

    fn on_notification(&mut self, method: &str, params: &Value) -> Step {
        let mut step = Step::default();
        if params
            .get("threadId")
            .and_then(Value::as_str)
            .is_some_and(|thread| thread != self.session)
        {
            return step;
        }
        let item_id = text(params, "itemId").unwrap_or_default();
        let delta = text(params, "delta").unwrap_or_default();
        match method {
            "item/started" => {
                if let Some(item) = params.get("item") {
                    self.item_started(item, &mut step.events);
                }
            }
            "item/completed" => {
                if let Some(item) = params.get("item") {
                    self.item_completed(item, &mut step.events);
                }
            }
            "item/agentMessage/delta" => {
                self.open_message(&item_id, &mut step.events);
                self.delivered_text.insert(item_id.clone(), true);
                step.events.push(
                    AgUiEvent::TextMessageContent {
                        message_id: item_id,
                        delta,
                    }
                    .into(),
                );
            }
            "item/reasoning/summaryTextDelta" | "item/reasoning/textDelta" => {
                self.open_reasoning(&item_id, &mut step.events);
                step.events.push(
                    AgUiEvent::ReasoningMessageContent {
                        message_id: item_id,
                        delta,
                    }
                    .into(),
                );
            }
            "item/commandExecution/outputDelta" | "item/fileChange/outputDelta" => {
                step.events.push(
                    AgUiEvent::Custom {
                        name: "tool.output".into(),
                        value: json!({ "toolCallId": item_id, "delta": delta }),
                    }
                    .into(),
                );
            }
            "turn/diff/updated" => {
                let diff = text(params, "diff").unwrap_or_default();
                let mut content = diff_activity(&diff);
                content["diff"] = json!(diff);
                step.events.push(
                    AgUiEvent::ActivitySnapshot {
                        message_id: format!("diff-{}", params_turn(params)),
                        activity_type: "diff".into(),
                        content,
                        replace: Some(true),
                    }
                    .into(),
                );
            }
            "turn/plan/updated" => {
                step.events.push(
                    AgUiEvent::ActivitySnapshot {
                        message_id: format!("plan-{}", params_turn(params)),
                        activity_type: "plan".into(),
                        content: plan_content(params),
                        replace: Some(true),
                    }
                    .into(),
                );
            }
            "error" => {
                let message = params
                    .pointer("/error/message")
                    .and_then(Value::as_str)
                    .unwrap_or("Codex reported an error.")
                    .to_owned();
                if params.get("willRetry").and_then(Value::as_bool) == Some(true) {
                    step.events.push(
                        AgUiEvent::Custom {
                            name: "engine.retrying".into(),
                            value: json!({ "message": message }),
                        }
                        .into(),
                    );
                } else {
                    self.last_error = Some(message);
                }
            }
            "thread/tokenUsage/updated" => {
                let usage = params.get("tokenUsage").cloned().unwrap_or(Value::Null);
                let report = ThreadUsage {
                    total_tokens: usage.pointer("/total/totalTokens").and_then(Value::as_u64),
                    context_window: usage.get("modelContextWindow").and_then(Value::as_u64),
                    raw: usage,
                };
                step.events.push(
                    AgUiEvent::Custom {
                        name: "usage".into(),
                        value: json!(report),
                    }
                    .into(),
                );
                step.events.push(EngineEvent::Usage(report));
            }
            "warning" => {
                step.events.push(
                    AgUiEvent::Custom {
                        name: "engine.warning".into(),
                        value: json!({ "message": text(params, "message") }),
                    }
                    .into(),
                );
            }
            "turn/completed" => {
                let turn = params.get("turn").cloned().unwrap_or(Value::Null);
                step.outcome = Some(match turn.get("status").and_then(Value::as_str) {
                    Some("completed") => EngineOutcome::Completed,
                    Some("interrupted") => EngineOutcome::Cancelled,
                    _ => EngineOutcome::Failed(
                        turn.pointer("/error/message")
                            .and_then(Value::as_str)
                            .map(str::to_owned)
                            .or_else(|| self.last_error.take())
                            .unwrap_or_else(|| "Codex failed the turn.".to_owned()),
                    ),
                });
            }
            _ => tracing::trace!(%method, "ignored Codex notification"),
        }
        step
    }

    fn open_message(&mut self, id: &str, events: &mut Vec<EngineEvent>) {
        if self.open.insert(id.to_owned(), ItemKind::Message).is_none() {
            events.push(
                AgUiEvent::TextMessageStart {
                    message_id: id.to_owned(),
                    role: "assistant".into(),
                }
                .into(),
            );
        }
    }

    fn open_reasoning(&mut self, id: &str, events: &mut Vec<EngineEvent>) {
        if self
            .open
            .insert(id.to_owned(), ItemKind::Reasoning)
            .is_none()
        {
            events.push(
                AgUiEvent::ReasoningMessageStart {
                    message_id: id.to_owned(),
                    role: "reasoning".into(),
                }
                .into(),
            );
        }
    }

    fn open_tool(&mut self, id: &str, name: String, args: Value, events: &mut Vec<EngineEvent>) {
        if self.open.insert(id.to_owned(), ItemKind::Tool).is_none() {
            events.push(
                AgUiEvent::ToolCallStart {
                    tool_call_id: id.to_owned(),
                    tool_call_name: name,
                }
                .into(),
            );
            events.push(
                AgUiEvent::ToolCallArgs {
                    tool_call_id: id.to_owned(),
                    delta: args.to_string(),
                }
                .into(),
            );
        }
    }

    fn item_started(&mut self, item: &Value, events: &mut Vec<EngineEvent>) {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            return;
        };
        match item.get("type").and_then(Value::as_str) {
            Some("agentMessage") => self.open_message(id, events),
            Some("reasoning") => self.open_reasoning(id, events),
            Some("collabAgentToolCall" | "subAgentActivity") => {
                events.push(
                    AgUiEvent::Custom {
                        name: "subagent.activity".into(),
                        value: json!({
                            "id": id,
                            "kind": item.get("type"),
                            "tool": item.get("tool"),
                            "status": item.get("status"),
                            "agentPath": item.get("agentPath"),
                        }),
                    }
                    .into(),
                );
            }
            Some(kind) => {
                if let Some((name, args)) = tool_shape(kind, item) {
                    if kind == "fileChange" {
                        self.file_paths.insert(id.to_owned(), change_paths(item));
                    }
                    self.open_tool(id, name, args, events);
                }
            }
            None => {}
        }
    }

    fn item_completed(&mut self, item: &Value, events: &mut Vec<EngineEvent>) {
        let Some(id) = item.get("id").and_then(Value::as_str) else {
            return;
        };
        let kind = item.get("type").and_then(Value::as_str).unwrap_or("item");
        let exit_code = item.get("exitCode").and_then(Value::as_i64);
        events.push(EngineEvent::Item(ItemRecord {
            id: id.to_owned(),
            kind: kind.to_owned(),
            raw: item.clone(),
            exit_code,
        }));
        if let Some(code) = exit_code {
            events.push(
                AgUiEvent::Custom {
                    name: "tool.finished".into(),
                    value: json!({ "toolCallId": id, "exitCode": code }),
                }
                .into(),
            );
        }
        match item.get("type").and_then(Value::as_str) {
            Some("agentMessage") => {
                self.open_message(id, events);
                if !self.delivered_text.contains_key(id) {
                    events.push(
                        AgUiEvent::TextMessageContent {
                            message_id: id.to_owned(),
                            delta: text(item, "text").unwrap_or_default(),
                        }
                        .into(),
                    );
                }
                self.open.remove(id);
                events.push(
                    AgUiEvent::TextMessageEnd {
                        message_id: id.to_owned(),
                    }
                    .into(),
                );
            }
            Some("reasoning") => {
                if self.open.remove(id).is_some() {
                    events.push(
                        AgUiEvent::ReasoningMessageEnd {
                            message_id: id.to_owned(),
                        }
                        .into(),
                    );
                }
            }
            Some(kind) => {
                let Some((name, args)) = tool_shape(kind, item) else {
                    return;
                };
                self.open_tool(id, name, args, events);
                self.open.remove(id);
                self.file_paths.remove(id);
                events.push(
                    AgUiEvent::ToolCallEnd {
                        tool_call_id: id.to_owned(),
                    }
                    .into(),
                );
                events.push(
                    AgUiEvent::ToolCallResult {
                        message_id: new_id(),
                        tool_call_id: id.to_owned(),
                        content: tool_output(item),
                        role: Some("tool".into()),
                    }
                    .into(),
                );
            }
            None => {}
        }
    }

    fn close_open(&mut self) -> Vec<EngineEvent> {
        self.open
            .drain()
            .map(|(id, kind)| {
                match kind {
                    ItemKind::Message => AgUiEvent::TextMessageEnd { message_id: id },
                    ItemKind::Reasoning => AgUiEvent::ReasoningMessageEnd { message_id: id },
                    ItemKind::Tool => AgUiEvent::ToolCallEnd { tool_call_id: id },
                }
                .into()
            })
            .collect()
    }
}

fn params_turn(params: &Value) -> String {
    text(params, "turnId").unwrap_or_default()
}

fn plan_content(params: &Value) -> Value {
    let steps: Vec<Value> = params
        .get("plan")
        .and_then(Value::as_array)
        .map(|plan| {
            plan.iter()
                .map(|step| {
                    let status = match step.get("status").and_then(Value::as_str) {
                        Some("inProgress") => "in_progress",
                        Some(other) => other,
                        None => "pending",
                    };
                    json!({ "title": text(step, "step").unwrap_or_default(), "status": status })
                })
                .collect()
        })
        .unwrap_or_default();
    json!({ "steps": steps, "explanation": params.get("explanation") })
}

fn tool_shape(kind: &str, item: &Value) -> Option<(String, Value)> {
    match kind {
        "commandExecution" => Some((
            "command".to_owned(),
            json!({ "command": item.get("command"), "cwd": item.get("cwd") }),
        )),
        "fileChange" => Some((
            "file_change".to_owned(),
            json!({ "paths": change_paths(item) }),
        )),
        "mcpToolCall" => Some((
            format!(
                "{}.{}",
                text(item, "server").unwrap_or_default(),
                text(item, "tool").unwrap_or_default()
            ),
            item.get("arguments").cloned().unwrap_or(Value::Null),
        )),
        "dynamicToolCall" => Some((
            text(item, "tool").unwrap_or_else(|| "tool".to_owned()),
            item.get("arguments").cloned().unwrap_or(Value::Null),
        )),
        "webSearch" => Some((
            "web_search".to_owned(),
            json!({ "query": item.get("query") }),
        )),
        "imageView" => Some(("image_view".to_owned(), json!({ "path": item.get("path") }))),
        _ => None,
    }
}

fn change_paths(item: &Value) -> Vec<String> {
    item.get("changes")
        .and_then(Value::as_array)
        .map(|changes| {
            changes
                .iter()
                .filter_map(|change| text(change, "path"))
                .collect()
        })
        .unwrap_or_default()
}

fn tool_output(item: &Value) -> String {
    for key in ["aggregatedOutput", "error"] {
        if let Some(value) = item.get(key).filter(|value| !value.is_null()) {
            return match value {
                Value::String(text) => text.clone(),
                other => other.to_string(),
            };
        }
    }
    item.get("result")
        .filter(|value| !value.is_null())
        .map_or_else(
            || text(item, "status").unwrap_or_default(),
            Value::to_string,
        )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mapper() -> TurnMapper {
        TurnMapper::new("thread".into())
    }

    #[test]
    fn real_login_status_is_recognized() {
        assert_eq!(
            parse_login(0, "Logged in using ChatGPT\n"),
            AuthState::LoggedIn
        );
        assert_eq!(parse_login(1, "Not logged in\n"), AuthState::LoggedOut);
    }

    #[test]
    fn other_threads_cannot_finish_this_turn() {
        let mut mapper = mapper();
        let step = mapper.on_notification(
            "turn/completed",
            &json!({ "threadId": "subagent", "turn": { "status": "completed" } }),
        );
        assert!(step.outcome.is_none());
    }

    #[test]
    fn completed_without_started_still_produces_a_whole_message() {
        let mut mapper = mapper();
        let step = mapper.on_notification(
            "item/completed",
            &json!({ "threadId": "thread", "item": { "type": "agentMessage", "id": "m", "text": "hi" } }),
        );
        // The raw item for the inspector, then start, content and end.
        assert_eq!(step.events.len(), 4);
        assert!(mapper.open.is_empty());
    }

    #[test]
    fn completed_commands_keep_their_exit_code_and_raw_item() {
        let mut mapper = mapper();
        let step = mapper.on_notification(
            "item/completed",
            &json!({ "threadId": "thread", "item": {
                "type": "commandExecution", "id": "c", "command": "false",
                "status": "failed", "exitCode": 1, "aggregatedOutput": "boom",
            }}),
        );
        assert!(matches!(
            &step.events[0],
            EngineEvent::Item(item) if item.exit_code == Some(1) && item.kind == "commandExecution"
        ));
        assert!(step.events.iter().any(|event| matches!(
            event,
            EngineEvent::Agui(AgUiEvent::Custom { name, .. }) if name == "tool.finished"
        )));
    }

    #[test]
    fn usage_reports_totals_and_the_window() {
        let mut mapper = mapper();
        let step = mapper.on_notification(
            "thread/tokenUsage/updated",
            &json!({ "threadId": "thread", "tokenUsage": {
                "total": { "totalTokens": 120 }, "modelContextWindow": 1000,
            }}),
        );
        assert!(step.events.iter().any(|event| matches!(
            event,
            EngineEvent::Usage(usage)
                if usage.total_tokens == Some(120) && usage.context_window == Some(1000)
        )));
    }

    #[test]
    fn deltas_are_not_repeated_by_the_completed_item() {
        let mut mapper = mapper();
        let params = json!({ "threadId": "thread", "itemId": "m", "delta": "hi", "turnId": "t" });
        assert_eq!(
            mapper
                .on_notification("item/agentMessage/delta", &params)
                .events
                .len(),
            2
        );
        let done = mapper.on_notification(
            "item/completed",
            &json!({ "threadId": "thread", "item": { "type": "agentMessage", "id": "m", "text": "hi" } }),
        );
        // The raw item and the end, with no second copy of the text.
        assert_eq!(done.events.len(), 2);
    }

    #[test]
    fn failed_turn_reports_the_last_error() {
        let mut mapper = mapper();
        mapper.on_notification(
            "error",
            &json!({ "threadId": "thread", "willRetry": false, "error": { "message": "quota" } }),
        );
        let step = mapper.on_notification(
            "turn/completed",
            &json!({ "threadId": "thread", "turn": { "status": "failed", "error": null } }),
        );
        assert_eq!(step.outcome, Some(EngineOutcome::Failed("quota".into())));
    }

    #[test]
    fn approval_replies_match_each_schema() {
        let allow = Verdict::Allow;
        let deny = Verdict::Deny("no".into());
        let params = json!({ "permissions": { "network": { "enabled": true } } });
        assert_eq!(
            approval_response("item/commandExecution/requestApproval", &params, &allow),
            json!({ "decision": "accept" })
        );
        assert_eq!(
            approval_response("item/fileChange/requestApproval", &params, &deny),
            json!({ "decision": "decline" })
        );
        assert_eq!(
            approval_response("execCommandApproval", &params, &allow),
            json!({ "decision": "approved" })
        );
        assert_eq!(
            approval_response("applyPatchApproval", &params, &deny),
            json!({ "decision": "denied" })
        );
        assert_eq!(
            approval_response("item/permissions/requestApproval", &params, &allow),
            json!({ "permissions": { "network": { "enabled": true } }, "scope": "turn" })
        );
        assert_eq!(
            approval_response("item/permissions/requestApproval", &params, &deny),
            json!({ "permissions": {}, "scope": "turn" })
        );
    }

    #[test]
    fn mcp_server_name_cannot_merge_with_a_user_orbyn_entry() {
        let spec = RunSpec {
            run_id: "r".into(),
            thread_id: "t".into(),
            cwd: "/workspace".into(),
            checkout: "/workspace/repo/app".into(),
            prompt: "p".into(),
            user_prompt: "p".into(),
            kind: RunKind::Turn,
            plan: false,
            model: None,
            resume: None,
            mcp_url: Some("http://127.0.0.1:1/mcp/x".into()),
            run_dir: "/run".into(),
        };
        let config = thread_config(&spec);
        assert!(config["mcp_servers"]["orbyn"].is_null());
        assert_eq!(
            config["mcp_servers"]["orbyn_engineering"]["url"],
            "http://127.0.0.1:1/mcp/x"
        );
    }

    #[test]
    fn turns_write_only_to_the_selected_checkout() {
        let policy = sandbox_policy("workspace-write", std::path::Path::new("/w/repo/app"));
        assert_eq!(policy["type"], "workspaceWrite");
        assert_eq!(policy["writableRoots"], json!(["/w/repo/app"]));
        assert_eq!(
            sandbox_policy("read-only", std::path::Path::new("/x"))["type"],
            "readOnly"
        );
    }

    #[test]
    fn unknown_requests_are_not_classified() {
        let mapper = mapper();
        for method in [
            "account/chatgptAuthTokens/refresh",
            "item/tool/call",
            "item/tool/requestUserInput",
            "mcpServer/elicitation/request",
            "attestation/generate",
            "anything/new",
        ] {
            assert!(
                classify_request(method, &json!({}), &mapper).is_none(),
                "{method}"
            );
        }
    }

    #[test]
    fn plan_steps_use_the_activity_shape() {
        let content = plan_content(
            &json!({ "plan": [{ "step": "a", "status": "inProgress" }], "explanation": null }),
        );
        assert_eq!(
            content["steps"],
            json!([{ "title": "a", "status": "in_progress" }])
        );
    }
}
